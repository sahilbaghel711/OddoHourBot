require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const BASE_URL = process.env.ODOO_BASE_URL;
const LOGIN = process.env.ODOO_LOGIN;
const PASSWORD = process.env.ODOO_PASSWORD;

const UID = Number(process.env.ODOO_UID);
const COMPANY_ID = Number(process.env.ODOO_COMPANY_ID);
const LANG = process.env.ODOO_LANG || "en_US";
const TZ = process.env.ODOO_TZ || "Asia/Calcutta";
const CIDS = process.env.ODOO_CIDS || "3";

function assertEnv() {
  const missing = [];
  for (const [k, v] of Object.entries({
    ODOO_BASE_URL: BASE_URL,
    ODOO_LOGIN: LOGIN,
    ODOO_PASSWORD: PASSWORD,
    ODOO_UID: process.env.ODOO_UID,
    ODOO_COMPANY_ID: process.env.ODOO_COMPANY_ID,
  })) {
    if (!v) missing.push(k);
  }
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minDate(rows) {
  return rows.map((r) => r.date).sort()[0];
}

function maxDate(rows) {
  return rows
    .map((r) => r.date)
    .sort()
    .slice(-1)[0];
}

function groupByDate(rows) {
  const out = {};
  for (const row of rows) {
    if (!out[row.date]) out[row.date] = [];
    out[row.date].push(row);
  }
  return out;
}

function sumHours(rows) {
  return rows.reduce((sum, r) => sum + Number(r.hours || 0), 0);
}

function normalizeText(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function firstArrayResult(result) {
  return Array.isArray(result) ? result : [];
}

class OdooClient {
  constructor() {
    this.sessionId = null;
    this.cookieJar = {};
    this.csrfToken = null;

    this.http = axios.create({
      baseURL: BASE_URL,
      validateStatus: () => true,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 OdooHoursBot/1.0",
      },
    });
  }

  setCookiesFromHeaders(setCookieHeaders = []) {
    for (const cookieLine of setCookieHeaders) {
      const firstPart = cookieLine.split(";")[0];
      const eq = firstPart.indexOf("=");
      if (eq > 0) {
        const name = firstPart.slice(0, eq);
        const value = firstPart.slice(eq + 1);
        this.cookieJar[name] = value;
      }
    }
  }

  getCookieHeader() {
    const merged = {
      cids: CIDS,
      frontend_lang: LANG,
      tz: TZ,
      ...this.cookieJar,
    };
    return Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async getLoginPage() {
    const res = await this.http.get("/web/login", {
      headers: {
        Cookie: this.getCookieHeader(),
      },
    });

    this.setCookiesFromHeaders(res.headers["set-cookie"] || []);

    if (res.status < 200 || res.status >= 400) {
      throw new Error(`GET /web/login failed with status ${res.status}`);
    }

    const $ = cheerio.load(res.data);
    const token = $('input[name="csrf_token"]').attr("value");

    if (!token) {
      throw new Error("Could not extract csrf_token from /web/login");
    }

    this.csrfToken = token;
    return token;
  }

  async login() {
    await this.getLoginPage();

    const body = new URLSearchParams();
    body.set("csrf_token", this.csrfToken);
    body.set("login", LOGIN);
    body.set("password", PASSWORD);
    body.set("redirect", "");

    // Disable redirect following so we can capture the session_id cookie
    // that Odoo sets on the initial 302 response (axios drops it when redirecting).
    const res = await this.http.post("/web/login", body.toString(), {
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.getCookieHeader(),
      },
    });

    this.setCookiesFromHeaders(res.headers["set-cookie"] || []);

    if (!this.cookieJar.session_id) {
      throw new Error(
        "Login failed: session_id cookie not found after redirect response",
      );
    }

    return this.cookieJar.session_id;
  }

  async jsonRpc(url, payload) {
    const res = await this.http.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Cookie: this.getCookieHeader(),
      },
    });

    this.setCookiesFromHeaders(res.headers["set-cookie"] || []);

    if (res.status < 200 || res.status >= 400) {
      throw new Error(
        `HTTP ${res.status} on ${url}: ${JSON.stringify(res.data)}`,
      );
    }

    if (res.data && res.data.error) {
      throw new Error(
        `Odoo error on ${url}: ${JSON.stringify(res.data.error, null, 2)}`,
      );
    }

    return res.data.result;
  }

  context(extra = {}) {
    return {
      lang: LANG,
      tz: TZ,
      uid: UID,
      allowed_company_ids: [COMPANY_ID],
      ...extra,
    };
  }

  async callKw(model, method, args = [], kwargs = {}) {
    return this.jsonRpc(`/web/dataset/call_kw/${model}/${method}`, {
      jsonrpc: "2.0",
      method: "call",
      params: {
        model,
        method,
        args,
        kwargs,
      },
    });
  }

  async searchRead(model, domain, fields, extra = {}) {
    return this.jsonRpc("/web/dataset/search_read", {
      jsonrpc: "2.0",
      method: "call",
      params: {
        model,
        domain,
        fields,
        ...extra,
        context: this.context(extra.context || {}),
      },
    });
  }

  async getHolidays(fromDate, toDate) {
    return this.jsonRpc("/get_holidays", {
      jsonrpc: "2.0",
      method: "call",
      params: {
        from_date: fromDate,
        to_date: toDate,
      },
      id: Date.now(),
    });
  }

  async searchProject(projectName) {
    const result = await this.callKw("project.project", "name_search", [], {
      name: projectName,
      operator: "ilike",
      args: [],
      limit: 8,
      context: this.context({ dropdown_selection: true }),
    });

    return firstArrayResult(result);
  }

  async searchStory(projectCfg, storyText) {
    if (projectCfg.story_search_mode === "id_in_list_only") {
      const result = await this.callKw("project.task", "name_search", [], {
        name: storyText,
        operator: "ilike",
        args: [[["id", "in", projectCfg.story_ids || []]]],
        limit: 8,
        context: this.context({ dropdown_selection_for_devops_task: true }),
      });
      return firstArrayResult(result);
    }

    const result = await this.callKw("project.task", "name_search", [], {
      name: storyText,
      operator: "ilike",
      args: [["project_id", "=", projectCfg.project_id]],
      limit: 8,
      context: this.context({ dropdown_selection_for_devops_task: true }),
    });

    return firstArrayResult(result);
  }

  async searchChildTask(projectCfg, storyId, taskText) {
    const result = await this.callKw("project.task", "name_search", [], {
      name: taskText,
      operator: "ilike",
      args: [
        "&",
        "&",
        ["project_id", "=", projectCfg.project_id],
        ["parent_id", "=", storyId],
        "|",
        ["user_ids", "in", [UID]],
        ["user_ids", "=", false],
      ],
      limit: 8,
      context: this.context({ dropdown_selection_for_devops_task: true }),
    });

    return firstArrayResult(result);
  }

  async onchangeAnalyticLine(projectCfg, date, storyId, devopsTaskId = false) {
    return this.callKw(
      "account.analytic.line",
      "onchange",
      [
        [],
        {
          date,
          account_id: projectCfg.account_id,
          allocated_date: false,
          is_devops: true,
          devops_project_ids: projectCfg.project_id,
          project_id: projectCfg.project_id,
          task_id: storyId,
          devops_task_id: devopsTaskId || false,
          child_opp_name: projectCfg.child_opp_name,
          employee_id: projectCfg.employee_id,
          company_id: projectCfg.company_id,
          production: 0,
          qc: 0,
          admin: 0,
          rework: 0,
          unit_amount: 0,
          quantity: 0,
          unit_amount_allocated: 0,
          name: false,
          devops_story_points: false,
          devops_story_status: false,
          devops_area: false,
          devops_story_no: false,
          user_story_link: false,
          devops_work_package: false,
          devops_task_hours: 0,
          total_hours: 0,
          devops_task_status: false,
          devops_task_no: false,
          devops_tags_ids: [[6, false, []]],
          devops_task_link: false,
        },
        "date",
        {
          date: "1",
          account_id: "",
          allocated_date: "",
          is_devops: "1",
          devops_project_ids: "1",
          project_id: "1",
          task_id: "1",
          devops_task_id: "1",
          child_opp_name: "",
          employee_id: "1",
          company_id: "",
          production: "1",
          qc: "1",
          admin: "1",
          rework: "1",
          unit_amount: "1",
          quantity: "",
          unit_amount_allocated: "",
          name: "",
          devops_story_points: "",
          devops_story_status: "",
          devops_area: "",
          devops_story_no: "",
          user_story_link: "",
          devops_work_package: "",
          devops_task_hours: "",
          total_hours: "",
          devops_task_status: "",
          devops_task_no: "",
          devops_tags_ids: "",
          devops_task_link: "",
        },
      ],
      {
        context: this.context({
          date,
          lead_id: projectCfg.lead_id,
          child_opp_name: projectCfg.child_opp_name,
          project_id: projectCfg.project_id,
          task_id: storyId,
          default_date: date,
          default_lead_id: projectCfg.lead_id,
          default_child_opp_name: projectCfg.child_opp_name,
          default_project_id: projectCfg.project_id,
          default_task_id: storyId,
        }),
      },
    );
  }

  async createAnalyticLine(projectCfg, row, storyId, devopsTaskId = false) {
    const payload = {
      date: row.date,
      account_id: projectCfg.account_id,
      allocated_date: false,
      is_devops: true,
      task_id: storyId,
      devops_task_id: devopsTaskId || false,
      production: Number(row.hours),
      qc: 0,
      admin: 0,
      rework: 0,
      unit_amount: Number(row.hours),
      quantity: 0,
      unit_amount_allocated: 0,
      name: row.task || row.story,
    };

    return this.callKw("account.analytic.line", "create", [payload], {
      context: this.context({
        date: row.date,
        lead_id: projectCfg.lead_id,
        child_opp_name: projectCfg.child_opp_name,
        project_id: projectCfg.project_id,
        task_id: storyId,
        default_date: row.date,
        default_lead_id: projectCfg.lead_id,
        default_child_opp_name: projectCfg.child_opp_name,
        default_project_id: projectCfg.project_id,
        default_task_id: storyId,
      }),
    });
  }

  async writeAnalyticLine(lineId, hours) {
    return this.callKw(
      "account.analytic.line",
      "write",
      [[lineId], { production: Number(hours), unit_amount: Number(hours) }],
      { context: this.context() },
    );
  }

  async readExistingLines(fromDate, toDate) {
    const result = await this.searchRead(
      "account.analytic.line",
      [
        "&",
        "&",
        ["user_id", "=", UID],
        ["project_id", "!=", false],
        ["task_id", "!=", false],
        ["date", "<=", toDate],
        ["date", ">=", fromDate],
      ],
      [
        "display_name",
        "date",
        "lead_id",
        "child_opp_name",
        "project_id",
        "task_id",
        "unit_amount",
        "employee_id",
        "allocated_date",
        "unit_amount_allocated",
        "company_id",
        "devops_task_id",
        "production",
        "qc",
        "rework",
        "admin",
        "color_code",
        "name",
      ],
      {
        sort: "date ASC",
      },
    );

    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.records)) return result.records;
    return [];
  }
}

function pickBestNameSearchMatch(results, desiredText) {
  if (!results.length) return null;

  const desired = normalizeText(desiredText);

  let exact = results.find(([id, label]) => normalizeText(label) === desired);
  if (exact) return { id: exact[0], label: exact[1] };

  let contains = results.find(([id, label]) =>
    normalizeText(label).includes(desired),
  );
  if (contains) return { id: contains[0], label: contains[1] };

  return { id: results[0][0], label: results[0][1] };
}

function getMany2oneId(value) {
  if (Array.isArray(value)) return value[0];
  return value || false;
}

function makeLineKey(date, projectId, storyId, devopsTaskId) {
  return [date, projectId || "", storyId || "", devopsTaskId || ""].join("|");
}

function buildExistingLineMap(lines) {
  const map = new Map();
  for (const line of lines) {
    const key = makeLineKey(
      line.date,
      getMany2oneId(line.project_id),
      getMany2oneId(line.task_id),
      getMany2oneId(line.devops_task_id),
    );
    map.set(key, line);
  }
  return map;
}

async function runFillHours(entries, config) {
  for (const row of entries) {
    if (!config[row.project]) {
      throw new Error(`Project config missing for "${row.project}"`);
    }
    if (!row.date || !row.project || !row.story || row.hours == null) {
      throw new Error(`Invalid entry row: ${JSON.stringify(row)}`);
    }
  }

  const byDate = groupByDate(entries);
  for (const [date, rows] of Object.entries(byDate)) {
    const total = sumHours(rows);
    if (total > 8) {
      throw new Error(`Total for ${date} is ${total}, greater than 8`);
    }
    if (total !== 8) {
      console.log(`Warning: ${date} totals ${total}, not 8`);
    }
  }

  const client = new OdooClient();

  console.log("Logging in...");
  await client.login();
  console.log("Login successful.");

  const fromDate = minDate(entries);
  const toDate = maxDate(entries);

  console.log(`Fetching existing lines for ${fromDate} to ${toDate}...`);
  const existingLines = await client.readExistingLines(fromDate, toDate);
  console.log(`Found ${existingLines.length} existing lines.`);

  const existingMap = buildExistingLineMap(existingLines);

  try {
    const holidays = await client.getHolidays(fromDate, toDate);
    console.log("Holiday response fetched.");
    if (holidays) {
      console.log(JSON.stringify(holidays, null, 2));
    }
  } catch (err) {
    console.log(`Holiday fetch skipped: ${err.message}`);
  }

  const summary = [];

  for (const row of entries) {
    console.log(
      `\nProcessing: ${row.date} | ${row.project} | ${row.story} | ${row.task || "(story only)"} | ${row.hours}h`,
    );

    const projectCfg = config[row.project];

    let storyId;
    try {
      const storyResults = await client.searchStory(projectCfg, row.story);
      if (!storyResults.length) {
        throw new Error(
          `Story "${row.story}" not found in Odoo under project "${row.project}"`,
        );
      }
      storyId = pickBestNameSearchMatch(storyResults, row.story).id;
    } catch (err) {
      console.log(`SYNC FAIL (story): ${err.message}`);
      summary.push({
        action: "failed",
        reason: "story_not_found",
        error: err.message,
        date: row.date,
        project: row.project,
        story: row.story,
        task: row.task || null,
        hours: row.hours,
      });
      await sleep(250);
      continue;
    }

    let devopsTaskId = false;
    if (row.task && projectCfg.task_search_mode !== "none") {
      try {
        const taskResults = await client.searchChildTask(
          projectCfg,
          storyId,
          row.task,
        );
        if (!taskResults.length) {
          throw new Error(
            `Task "${row.task}" not found in Odoo under story "${row.story}"`,
          );
        }
        devopsTaskId = pickBestNameSearchMatch(taskResults, row.task).id;
      } catch (err) {
        console.log(`SYNC FAIL (task): ${err.message}`);
        summary.push({
          action: "failed",
          reason: "task_not_found",
          error: err.message,
          date: row.date,
          project: row.project,
          story: row.story,
          task: row.task || null,
          hours: row.hours,
        });
        await sleep(250);
        continue;
      }
    }

    const key = makeLineKey(
      row.date,
      projectCfg.project_id,
      storyId,
      devopsTaskId,
    );
    const existing = existingMap.get(key);

    if (!existing) {
      try {
        await client.onchangeAnalyticLine(
          projectCfg,
          row.date,
          storyId,
          devopsTaskId,
        );
      } catch (err) {
        console.log(`onchange skipped: ${err.message}`);
      }

      let newId;
      try {
        newId = await client.createAnalyticLine(
          projectCfg,
          row,
          storyId,
          devopsTaskId,
        );
      } catch (err) {
        console.log(`CREATE FAIL: ${err.message}`);
        summary.push({
          action: "failed",
          reason: "create_error",
          error: err.message,
          date: row.date,
          project: row.project,
          story: row.story,
          task: row.task || null,
          hours: row.hours,
        });
        await sleep(250);
        continue;
      }
      console.log(`Created line ${newId}`);

      summary.push({
        action: "created",
        lineId: newId,
        date: row.date,
        project: row.project,
        story: row.story,
        task: row.task || null,
        hours: row.hours,
      });
    } else {
      const existingHours = Number(
        existing.unit_amount ?? existing.production ?? 0,
      );
      if (existingHours === Number(row.hours)) {
        console.log(
          `No change needed for line ${existing.id || "(unknown id)"}`,
        );
        summary.push({
          action: "unchanged",
          lineId: existing.id || null,
          date: row.date,
          project: row.project,
          story: row.story,
          task: row.task || null,
          hours: row.hours,
        });
      } else {
        if (!existing.id) {
          throw new Error(
            `Existing line found but no record id available in search_read result for key ${key}`,
          );
        }
        try {
          await client.writeAnalyticLine(existing.id, row.hours);
        } catch (err) {
          console.log(`UPDATE FAIL: ${err.message}`);
          summary.push({
            action: "failed",
            reason: "update_error",
            error: err.message,
            date: row.date,
            project: row.project,
            story: row.story,
            task: row.task || null,
            hours: row.hours,
          });
          await sleep(250);
          continue;
        }
        console.log(
          `Updated line ${existing.id} from ${existingHours}h to ${row.hours}h`,
        );
        summary.push({
          action: "updated",
          lineId: existing.id,
          date: row.date,
          project: row.project,
          story: row.story,
          task: row.task || null,
          oldHours: existingHours,
          hours: row.hours,
        });
      }
    }

    await sleep(250);
  }

  return summary;
}

async function main() {
  assertEnv();
  const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
  const entries = JSON.parse(fs.readFileSync("./entries.json", "utf8"));
  const summary = await runFillHours(entries, config);
  console.log("\nSummary:");
  console.table(summary);
}

module.exports = { runFillHours, assertEnv, OdooClient };

if (require.main === module) {
  main().catch((err) => {
    console.error("\nERROR:");
    console.error(err.message);
    process.exit(1);
  });
}
