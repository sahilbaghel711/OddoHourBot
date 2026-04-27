require("dotenv").config();
const axios = require("axios");
const fs = require("fs");

const ORG = process.env.ADO_ORG;
const PROJECT = process.env.ADO_PROJECT;
const PAT = process.env.ADO_PAT;
const ITERATION_PATH = process.env.ADO_ITERATION_PATH;
const AREA_PATH = process.env.ADO_AREA_PATH;
const ODOO_DEFAULT_PROJECT =
  process.env.ODOO_DEFAULT_PROJECT || "PCA Track 2 - PCA";

if (!ORG || !PROJECT || !PAT) {
  throw new Error("Missing ADO_ORG, ADO_PROJECT, or ADO_PAT in .env");
}

const api = axios.create({
  baseURL: `https://dev.azure.com/${ORG}`,
  headers: {
    Authorization: `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`,
    "Content-Type": "application/json",
  },
  validateStatus: () => true,
});

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function extractParentId(workItem) {
  const rels = workItem.relations || [];
  const parentRel = rels.find(
    (r) => r.rel === "System.LinkTypes.Hierarchy-Reverse",
  );
  if (!parentRel) return null;
  const parts = parentRel.url.split("/");
  return Number(parts[parts.length - 1]);
}

async function queryWiql() {
  const where = [
    `[System.TeamProject] = '${PROJECT}'`,
    `[System.AssignedTo] = @Me`,
    `[System.WorkItemType] IN ('Task', 'Bug', 'User Story')`,
    `[System.State] <> 'Closed'`,
  ];

  if (AREA_PATH) {
    where.push(`[System.AreaPath] UNDER '${AREA_PATH}'`);
  }

  if (ITERATION_PATH) {
    // Use UNDER so a parent path (e.g. "MyProject\2026\April") matches all
    // child sprints beneath it, enabling full-month (or multi-sprint) queries.
    where.push(`[System.IterationPath] UNDER '${ITERATION_PATH}'`);
  }

  const wiql = `
    SELECT
      [System.Id],
      [System.Title],
      [System.WorkItemType],
      [System.State]
    FROM WorkItems
    WHERE
      ${where.join("\n      AND ")}
    ORDER BY [System.ChangedDate] DESC
  `;

  const res = await api.post(
    `/${encodeURIComponent(PROJECT)}/_apis/wit/wiql?api-version=7.1`,
    { query: wiql },
  );

  if (res.status < 200 || res.status >= 400 || res.data?.error) {
    throw new Error(`WIQL failed: ${JSON.stringify(res.data, null, 2)}`);
  }

  return (res.data.workItems || []).map((w) => w.id);
}

async function getWorkItemsBatch(ids) {
  const all = [];

  for (const idsChunk of chunk(ids, 200)) {
    // ADO does not allow `fields` and `$expand` in the same request.
    // Fetch fields and relations in separate calls, then merge.
    const [fieldsRes, relationsRes] = await Promise.all([
      api.post(
        `/${encodeURIComponent(PROJECT)}/_apis/wit/workitemsbatch?api-version=7.1`,
        {
          ids: idsChunk,
          fields: [
            "System.Id",
            "System.Title",
            "System.WorkItemType",
            "System.State",
            "System.AreaPath",
            "System.IterationPath",
            "System.AssignedTo",
          ],
        },
      ),
      api.post(
        `/${encodeURIComponent(PROJECT)}/_apis/wit/workitemsbatch?api-version=7.1`,
        {
          ids: idsChunk,
          $expand: "Relations",
        },
      ),
    ]);

    if (
      fieldsRes.status < 200 ||
      fieldsRes.status >= 400 ||
      fieldsRes.data?.error
    ) {
      throw new Error(
        `WorkItemsBatch failed: ${JSON.stringify(fieldsRes.data, null, 2)}`,
      );
    }
    if (
      relationsRes.status < 200 ||
      relationsRes.status >= 400 ||
      relationsRes.data?.error
    ) {
      throw new Error(
        `WorkItemsBatch failed: ${JSON.stringify(relationsRes.data, null, 2)}`,
      );
    }

    const relationsById = new Map(
      (relationsRes.data.value || []).map((item) => [
        item.id,
        item.relations || [],
      ]),
    );

    for (const item of fieldsRes.data.value || []) {
      item.relations = relationsById.get(item.id) || [];
      all.push(item);
    }
  }

  return all;
}

async function main() {
  console.log("Querying ADO...");
  const ids = await queryWiql();

  if (!ids.length) {
    console.log("No matching work items found.");
    fs.writeFileSync("./entries.from.ado.json", "[]");
    return;
  }

  console.log(`Found ${ids.length} work items.`);
  const items = await getWorkItemsBatch(ids);

  const byId = new Map();
  for (const item of items) {
    byId.set(item.id, {
      id: item.id,
      title: item.fields?.["System.Title"] || null,
      type: item.fields?.["System.WorkItemType"] || null,
      state: item.fields?.["System.State"] || null,
      areaPath: item.fields?.["System.AreaPath"] || null,
      iterationPath: item.fields?.["System.IterationPath"] || null,
      parentId: extractParentId(item),
    });
  }

  // If parent user stories were not already in the first result set, fetch them.
  const missingParentIds = [
    ...new Set(
      [...byId.values()]
        .map((x) => x.parentId)
        .filter(Boolean)
        .filter((id) => !byId.has(id)),
    ),
  ];

  if (missingParentIds.length) {
    console.log(`Fetching ${missingParentIds.length} missing parent items...`);
    const parents = await getWorkItemsBatch(missingParentIds);
    for (const item of parents) {
      byId.set(item.id, {
        id: item.id,
        title: item.fields?.["System.Title"] || null,
        type: item.fields?.["System.WorkItemType"] || null,
        state: item.fields?.["System.State"] || null,
        areaPath: item.fields?.["System.AreaPath"] || null,
        iterationPath: item.fields?.["System.IterationPath"] || null,
        parentId: extractParentId(item),
      });
    }
  }

  // Convert only Tasks/Bugs into Odoo-ready rows.
  const rows = [...byId.values()]
    .filter((x) => x.type === "Task" || x.type === "Bug")
    .map((task) => {
      const story = byId.get(task.parentId);
      return {
        adoTaskId: task.id,
        adoStoryId: story?.id || null,
        project: ODOO_DEFAULT_PROJECT,
        story: story?.title || null,
        task: task.title,
        areaPath: task.areaPath,
        iterationPath: task.iterationPath,
        state: task.state,
        hours: 0,
      };
    })
    .filter((r) => r.story);

  fs.writeFileSync("./entries.from.ado.json", JSON.stringify(rows, null, 2));
  console.log(`Wrote ${rows.length} rows to entries.from.ado.json`);
  console.table(
    rows.map((r) => ({
      story: r.story,
      task: r.task,
      state: r.state,
      hours: r.hours,
    })),
  );
}

main().catch((err) => {
  console.error("ERROR:");
  console.error(err.message);
  process.exit(1);
});
