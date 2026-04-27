// Redirect console.log to stderr — stdout is reserved for the MCP JSON-RPC stream
console.log = console.error;

require("dotenv").config();

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("fs");
const path = require("path");

const { runFillHours, assertEnv, OdooClient } = require("./bot.js");

function formatSummary(summary) {
  const succeeded = summary.filter((s) => s.action !== "failed");
  const failed = summary.filter((s) => s.action === "failed");

  const lines = [];

  if (succeeded.length) {
    lines.push(`✅ ${succeeded.length} logged successfully:`);
    for (const s of succeeded) {
      const lineRef = s.lineId ? ` (line ${s.lineId})` : "";
      lines.push(
        `  ${s.action.toUpperCase()} | ${s.date} | ${s.story}${s.task ? ` / ${s.task}` : ""} | ${s.hours}h${lineRef}`,
      );
    }
  }

  if (failed.length) {
    lines.push(`\n❌ ${failed.length} failed (Odoo/ADO out of sync):`);
    for (const s of failed) {
      lines.push(`  - Story: ${s.story}`);
      if (s.task) lines.push(`    Task/Bug: ${s.task}`);
      lines.push(`    Date: ${s.date} | Hours: ${s.hours}h`);
      lines.push(`    Reason: ${s.error}`);
    }
    lines.push(
      "\n⚠️ Pass the failed items above to your Odoo admin to sync the missing story/task entries.",
    );
  }

  return lines.join("\n");
}

const server = new McpServer({
  name: "odoo-hours",
  version: "1.0.0",
});

const entrySchema = z.object({
  date: z.string().describe("Date in YYYY-MM-DD format"),
  project: z
    .string()
    .describe("Project name exactly as it appears in config.json"),
  story: z.string().describe("User story name to search for"),
  task: z.string().optional().describe("Child task name (optional)"),
  hours: z.number().describe("Number of hours to log"),
});

server.tool(
  "fill_hours",
  "Log timesheet hours to Odoo for the given entries. Creates new lines or updates existing ones idempotently.",
  {
    entries: z
      .array(entrySchema)
      .min(1)
      .describe("Array of timesheet entries to submit"),
  },
  async ({ entries }) => {
    assertEnv();
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, "config.json"), "utf8"),
    );
    const summary = await runFillHours(entries, config);
    return { content: [{ type: "text", text: formatSummary(summary) }] };
  },
);

server.tool(
  "fill_hours_from_file",
  "Log timesheet hours to Odoo by reading entries from a JSON file on disk.",
  {
    filePath: z
      .string()
      .optional()
      .describe(
        "Absolute or relative path to an entries JSON file. Defaults to entries.json next to the server.",
      ),
  },
  async ({ filePath }) => {
    assertEnv();
    const resolvedPath = filePath
      ? path.resolve(filePath)
      : path.join(__dirname, "entries.json");
    const entries = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, "config.json"), "utf8"),
    );
    const summary = await runFillHours(entries, config);
    return {
      content: [
        {
          type: "text",
          text: `Source: ${resolvedPath}\n\n${formatSummary(summary)}`,
        },
      ],
    };
  },
);

server.tool(
  "check_holidays",
  "Fetch public holidays from Odoo for a given date range.",
  {
    fromDate: z.string().describe("Start date in YYYY-MM-DD format"),
    toDate: z.string().describe("End date in YYYY-MM-DD format"),
  },
  async ({ fromDate, toDate }) => {
    assertEnv();
    const client = new OdooClient();
    await client.login();
    let result;
    try {
      result = await client.getHolidays(fromDate, toDate);
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Holiday fetch failed: ${err.message}` },
        ],
      };
    }
    const text = result
      ? JSON.stringify(result, null, 2)
      : "No holidays returned.";
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "get_logged_hours",
  "Return all timesheet lines already logged in Odoo for a given date range, grouped by date with daily totals.",
  {
    fromDate: z.string().describe("Start date in YYYY-MM-DD format"),
    toDate: z.string().describe("End date in YYYY-MM-DD format"),
  },
  async ({ fromDate, toDate }) => {
    assertEnv();
    const client = new OdooClient();
    await client.login();
    const lines = await client.readExistingLines(fromDate, toDate);

    if (!lines.length) {
      return {
        content: [
          {
            type: "text",
            text: `No hours logged between ${fromDate} and ${toDate}.`,
          },
        ],
      };
    }

    // Group by date
    const byDate = {};
    for (const line of lines) {
      if (!byDate[line.date]) byDate[line.date] = [];
      byDate[line.date].push(line);
    }

    const sections = Object.keys(byDate)
      .sort()
      .map((date) => {
        const rows = byDate[date];
        const total = rows.reduce((s, r) => s + Number(r.unit_amount || 0), 0);
        const detail = rows
          .map((r) => {
            const project = Array.isArray(r.project_id)
              ? r.project_id[1]
              : r.project_id || "?";
            const task = Array.isArray(r.task_id)
              ? r.task_id[1]
              : r.task_id || "?";
            const hours = Number(r.unit_amount || 0);
            return `  - ${project} / ${task} — ${hours}h`;
          })
          .join("\n");
        return `${date} (${total}h / 8h)\n${detail}`;
      });

    return {
      content: [
        {
          type: "text",
          text: sections.join("\n\n"),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => {
    console.error("Odoo Hours MCP server running on stdio");
  })
  .catch((err) => {
    console.error("Server startup failed:", err);
    process.exit(1);
  });
