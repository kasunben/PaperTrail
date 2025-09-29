import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Embedded demo board blueprint
 * NOTE: Adjust schemaVersion if you bump it in the app.
 */
const demoBoard = {
  schemaVersion: 1,
  id: "board-sri-lanka-protests-2022",
  title: "Sri Lanka Protests — 2022 (Evidence Board Demo)",
  visibility: "public", // mapped to Board.visibility
  status: "draft", // mapped to Board.status
  nodes: [
    /* --- NODES --- */
    {
      id: "n-overview",
      type: "text",
      x: 80,
      y: 80,
      w: 380,
      data: {
        title: "Overview",
        text: "Public protests in 2022 over economic crisis, fuel/food shortages, and governance concerns.",
        html: "<p>Public protests in <strong>2022</strong> responding to the economic crisis, shortages, and governance concerns. Major gathering points included <em>Galle Face (GotaGoGama)</em>, with marches and demonstrations across Colombo and other districts.</p>",
        tags: ["context", "summary"],
      },
    },
    {
      id: "n-early-apr",
      type: "text",
      x: 606,
      y: 68,
      w: 360,
      data: {
        title: "Early April: Nationwide Protests",
        text: "Initial large-scale gatherings and curfew announcements.",
        html: "<ul><li>Spontaneous protests in Colombo and suburbs</li><li>Curfew periods announced/adjusted</li><li>Momentum grows toward a central camp</li></ul>",
        tags: ["phase:early", "timeline", "ts:2022-04-03t20:00"],
      },
    },
    {
      id: "n-gotagogama",
      type: "text",
      x: 1023,
      y: 4,
      w: 380,
      data: {
        title: "Galle Face – “GotaGoGama”",
        text: "Protest village forms at Galle Face Green (Colombo).",
        html: "<p>Protest village <strong>GotaGoGama</strong> established at Galle Face Green as a sustained, symbolic hub.</p><p>Facilities: tents, information desks, legal aid, medical tents.</p>",
        tags: ["camp", "colombo", "location", "ts:2022-04-09t10:00"],
      },
    },
    {
      id: "n-june-fuel",
      type: "text",
      x: 1495,
      y: 293,
      w: 360,
      data: {
        title: "June: Fuel/Power Pressure",
        text: "Fuel queues, power cuts, and escalating demonstrations.",
        html: "<p>Escalation with extended fuel queues and power cuts; protest actions spread, participation widens.</p>",
        tags: ["economy", "timeline", "ts:2022-06-20t08:00"],
      },
    },
    {
      id: "n-july9-march",
      type: "text",
      x: 1539,
      y: 537,
      w: 400,
      data: {
        title: "July 9: Mass March in Colombo",
        text: "Large crowds converge on central sites; major turning point.",
        html: "<p><strong>July 9</strong>: Large crowds converge on central Colombo locations. A major turning point day with nationwide attention.</p>",
        tags: ["colombo", "timeline", "ts:2022-07-09t15:00", "turning-point"],
      },
    },
    {
      id: "n-pres-house",
      type: "image",
      x: 2026,
      y: 336,
      w: 360,
      data: {
        title: "Colombo: Central Precinct (illustrative)",
        descHtml: "Illustrative image placeholder for central Colombo area.",
        imageUrl: "https://upload.wikimedia.org/wikipedia/commons/f/f0/Colombo_-_Galle_Face.jpg",
        tags: ["illustration", "location", "ts:2022-07-09t16:00"],
      },
    },
    {
      id: "n-social",
      type: "link",
      x: 1583,
      y: 823,
      w: 380,
      data: {
        title: "Social Media Compilation (example)",
        descHtml: "Example compilation placeholder for public footage from July events.",
        linkUrl: "https://www.youtube.com/",
        tags: ["media", "source", "ts:2022-07-10t09:00"],
      },
    },
    {
      id: "n-legal-aid",
      type: "text",
      x: 1449,
      y: 15,
      w: 380,
      data: {
        title: "Support & Legal Aid",
        text: "Volunteer legal/medical aid at Galle Face and around protest sites.",
        html: "<ul><li>Volunteer legal desks</li><li>Medical tents and water distribution</li><li>Coordination via community groups</li></ul>",
        tags: ["camp", "support", "ts:2022-05-01t11:00"],
      },
    },
    {
      id: "n-incidents",
      type: "text",
      x: 80,
      y: 382,
      w: 420,
      data: {
        title: "Notable Incidents (High Level)",
        text: "Clashes, curfews, and announcements across different dates.",
        html: "<p>Selected incidents across dates (high level). Add your own entries per report and tag them with <code>ts:YYYY-MM-DDTHH:mm</code> for filtering.</p>",
        tags: ["incidents", "ts:2022-05-09t14:00"],
      },
    },
    {
      id: "n-maps",
      type: "link",
      x: 80,
      y: 648,
      w: 420,
      data: {
        title: "Map – Sri Lanka (OSM)",
        descHtml: "Use as geographic reference for districts and routes.",
        linkUrl: "https://www.openstreetmap.org/#map=7/7.87/80.77",
        tags: ["map", "reference", "ts:2022-04-10t09:00"],
      },
    },
    {
      id: "n-reading",
      type: "link",
      x: 80,
      y: 1001,
      w: 420,
      data: {
        title: "Background Reading (example source)",
        descHtml: "Placeholder link for international explainer/coverage.",
        linkUrl: "https://www.bbc.com/",
        tags: ["background", "source", "ts:2022-04-15t12:00"],
      },
    },
    {
      id: "n-photos",
      type: "image",
      x: 1057,
      y: 297,
      w: 360,
      data: {
        title: "Galle Face (illustrative)",
        descHtml: "Illustrative image placeholder for Galle Face area / camp vibe.",
        imageUrl:
          "https://thumbs.dreamstime.com/b/sri-lanka-mass-protest-movement-colombo-th-july-thousands-people-unite-near-beira-lake-estuary-presidential-secretary-hq-253149364.jpg",
        tags: ["camp", "illustration", "ts:2022-04-20t10:00"],
      },
    },
    {
      id: "n-hypothesis",
      type: "text",
      x: 1939,
      y: 80,
      w: 420,
      data: {
        title: "Synthesis / Hypothesis",
        text: "Escalation correlates with fuel/power stress and key weekend mobilizations.",
        html: "<p><strong>Synthesis:</strong> escalation appears correlated with fuel/power stress and weekend mobilizations; activity coalesces at central hubs.</p><p>Use tags like <code>#ts:2022-07-09T15:00</code>, <code>#camp</code>, <code>#colombo</code> to filter views.</p>",
        tags: ["analysis", "summary"],
      },
    },
    {
      id: "n-mar31-mirihana",
      type: "text",
      x: 80,
      y: 1354,
      w: 420,
      data: {
        title: "Mar 31: Protest at President’s private residence (Mirihana)",
        html: '<p>Demonstrators march to President Gotabaya Rajapaksa’s private residence amid worsening economic conditions.</p><p class="source">Source: <a href="https://reuters.screenocean.com/record/1682129">Reuters Archive: Timeline page</a></p>',
        tags: ["colombo", "timeline", "ts:2022-03-31t21:00"],
      },
    },
    {
      id: "n-apr3-cabinet",
      type: "text",
      x: 546,
      y: 314,
      w: 420,
      data: {
        title: "Apr 3: Cabinet dissolved",
        html: '<p>President dissolves the cabinet; Mahinda Rajapaksa remains PM.</p><p class="source">Source: <a href="https://reuters.screenocean.com/record/1682129">Reuters Archive: Timeline page</a></p>',
        tags: ["timeline", "ts:2022-04-03t20:00"],
      },
    },
    {
      id: "n-apr9-gotagogama",
      type: "text",
      x: 551,
      y: 605,
      w: 420,
      data: {
        title: "Apr 9: GotaGoGama forms at Galle Face",
        html: '<p>Protest village <strong>GotaGoGama</strong> established at Galle Face Green as a sustained hub.</p><p class="source">Source: <a href="https://reuters.screenocean.com/record/1682129">Reuters Archive: Timeline page</a></p>',
        tags: ["camp", "colombo", "timeline", "ts:2022-04-09t10:00"],
      },
    },
    {
      id: "n-apr19-rambukkana",
      type: "text",
      x: 1094,
      y: 700,
      w: 420,
      data: {
        title: "Apr 19: First protester killed (Rambukkana)",
        html: '<p>Police fire on protesters at Rambukkana; one killed—first casualty of the protests.</p><p class="source">Source: <a href="https://www.aljazeera.com/news/2022/7/13/timeline-sri-lankas-worst-economic-political-crisis-in-decades">Al Jazeera timeline</a></p>',
        tags: ["casualty", "rambukkana", "timeline", "ts:2022-04-19t18:00"],
      },
    },
    {
      id: "n-may9-violence-pm-resigns",
      type: "text",
      x: 575,
      y: 896,
      w: 420,
      data: {
        title: "May 9: Galle Face attacked; PM resigns",
        html: '<p>Pro-government groups attack protesters at Galle Face; widespread clashes leave deaths and injuries. PM Mahinda Rajapaksa resigns.</p><p class="source">Source: <a href="https://reuters.screenocean.com/record/1682129">Reuters Archive: Timeline page</a></p>',
        tags: ["timeline", "ts:2022-05-09t15:00", "violence"],
      },
    },
    {
      id: "n-jun27-fuel-halt",
      type: "text",
      x: 1081,
      y: 993,
      w: 420,
      data: {
        title: "Jun 27: Fuel limited to essential services",
        html: '<p>Government restricts fuel to essential services for two weeks; schools shut and work-from-home urged.</p><p class="source">Source: <a href="https://www.reuters.com/world/asia-pacific/crisis-hit-sri-lanka-shuts-schools-urges-work-home-save-fuel-2022-06-27/">Reuters report</a></p>',
        tags: ["economy", "fuel", "timeline", "ts:2022-06-27t09:00"],
      },
    },
    {
      id: "n-jul9-storm-residence",
      type: "text",
      x: 2440,
      y: 30,
      w: 420,
      data: {
        title: "Jul 9: Protesters storm President’s House",
        html: '<p>Mass demonstrations in Colombo culminate in protesters entering the President’s House and the Presidential Secretariat; PM’s private residence set on fire.</p><p class="source">Source: <a href="https://www.theguardian.com/world/2022/jul/09/sri-lanka-protests-thousands-storm-presidents-residence-colombo">The Guardian report</a></p>',
        tags: ["colombo", "timeline", "ts:2022-07-09t15:00", "turning-point"],
      },
    },
    {
      id: "n-jul13-flee",
      type: "text",
      x: 2526,
      y: 362,
      w: 420,
      data: {
        title: "Jul 13: President flees country",
        html: '<p>President Gotabaya Rajapaksa flees to Maldives, later to Singapore.</p><p class="source">Source: <a href="https://reuters.screenocean.com/record/1682129">Reuters Archive: Timeline page</a></p>',
        tags: ["leadership", "timeline", "ts:2022-07-13t12:00"],
      },
    },
    {
      id: "n-jul14-resign",
      type: "text",
      x: 2495,
      y: 654,
      w: 420,
      data: {
        title: "Jul 14–15: Resignation confirmed; Acting President",
        html: '<p>Rajapaksa submits resignation; parliament accepts on Jul 15; Ranil Wickremesinghe sworn in as Acting President.</p><p class="source">Source: <a href="https://reuters.screenocean.com/record/1682129">Reuters Archive: Timeline page</a></p>',
        tags: ["leadership", "timeline", "ts:2022-07-14t18:00"],
      },
    },
    {
      id: "n-jul20-ranil-elected",
      type: "text",
      x: 2012,
      y: 758,
      w: 420,
      data: {
        title: "Jul 20–21: Ranil Wickremesinghe elected President",
        html: '<p>Parliament elects Wickremesinghe as President; sworn in the next day.</p><p class="source">Source: <a href="https://time.com/6198951/sri-lanka-ranil-wickeremesinghe-president-protests/">TIME / Welt summaries</a></p>',
        tags: ["leadership", "timeline", "ts:2022-07-20t12:00"],
      },
    },
    {
      id: "n-jul22-camp-raid",
      type: "text",
      x: 2081,
      y: 1015,
      w: 420,
      data: {
        title: "Jul 22: Security forces raid protest camp",
        html: '<p>Pre-dawn raid on the protest camp occupying government grounds; arrests reported.</p><p class="source">Source: <a href="https://reuters.screenocean.com/record/1682129">Reuters Archive: Timeline page</a></p>',
        tags: ["camp", "timeline", "ts:2022-07-22t05:30"],
      },
    },
    {
      id: "n-src-reuters-archive",
      type: "link",
      x: 612,
      y: 1176,
      w: 420,
      data: {
        title: "Reuters Archive: Timeline — How Sri Lankan protests unfolded",
        descHtml: "Primary timeline used for date anchors and sequence.",
        linkUrl: "https://reuters.screenocean.com/record/1682129",
        tags: ["primary", "source", "timeline"],
      },
    },
    {
      id: "n-src-thewire",
      type: "link",
      x: 78,
      y: 1581,
      w: 420,
      data: {
        title: "The Wire: The Timeline of the Sri Lankan Protests",
        descHtml: "Secondary timeline reference. (If blocked, use cached versions).",
        linkUrl: "https://thewire.in/south-asia/sri-lanka-protests-timeline",
        tags: ["source", "timeline"],
      },
    },
    {
      id: "n-src-reuters-fuel",
      type: "link",
      x: 543,
      y: 1497,
      w: 420,
      data: {
        title: "Reuters: Fuel restricted to essential services (Jun 27, 2022)",
        descHtml: "Context on the June fuel crisis tipping point.",
        linkUrl:
          "https://www.reuters.com/world/asia-pacific/crisis-hit-sri-lanka-shuts-schools-urges-work-home-save-fuel-2022-06-27/",
        tags: ["economy", "fuel", "source"],
      },
    },
    {
      id: "n-src-guardian",
      type: "link",
      x: 1076,
      y: 1229,
      w: 420,
      data: {
        title: "Guardian: President to resign after residence stormed (Jul 9, 2022)",
        descHtml: "Reporting on July 9 events and resignation pledge.",
        linkUrl:
          "https://www.theguardian.com/world/2022/jul/09/sri-lanka-protests-thousands-storm-presidents-residence-colombo",
        tags: ["event", "jul9", "source"],
      },
    },
    {
      id: "n-src-aljazeera",
      type: "link",
      x: 1557,
      y: 1174,
      w: 420,
      data: {
        title: "Al Jazeera: Timeline (includes Apr 19 casualty)",
        descHtml: "Cites first fatality at Rambukkana during April 19 protest.",
        linkUrl:
          "https://www.aljazeera.com/news/2022/7/13/timeline-sri-lankas-worst-economic-political-crisis-in-decades",
        tags: ["april19", "event", "source"],
      },
    },
    {
      id: "n-src-time",
      type: "link",
      x: 2071,
      y: 1290,
      w: 420,
      data: {
        title: "TIME: Ranil Wickremesinghe elected President",
        descHtml: "Context on the July 20 vote and aftermath.",
        linkUrl: "https://time.com/6198951/sri-lanka-ranil-wickeremesinghe-president-protests/",
        tags: ["leadership", "source"],
      },
    },
    {
      id: "n-provenance",
      type: "text",
      x: 1004,
      y: 1561,
      w: 880,
      data: {
        title: "Provenance / Chain of Custody",
        html: "<p>This board records each claim with date-stamped nodes and links to primary sources. Edges indicate sequence; tags like <code>ts:YYYY-MM-DDTHH:mm</code> enable timeline filtering. Source nodes (right column) preserve original URLs and descriptions for verification.</p><ul><li><strong>Fact capture:</strong> Nodes quote or paraphrase source claims with citations.</li><li><strong>Verification:</strong> Cross-check between Reuters archive timeline and other outlets.</li><li><strong>Integrity:</strong> Edits create new nodes; prior versions are exported in JSON for audit trails.</li></ul>",
        tags: ["howto", "provenance"],
      },
    },
  ],
  edges: [
    { id: "e1", sourceId: "n-overview", targetId: "n-early-apr" },
    { id: "e2", sourceId: "n-early-apr", targetId: "n-gotagogama" },
    { id: "e3", sourceId: "n-gotagogama", targetId: "n-photos" },
    { id: "e4", sourceId: "n-early-apr", targetId: "n-june-fuel" },
    { id: "e5", sourceId: "n-june-fuel", targetId: "n-july9-march" },
    { id: "e6", sourceId: "n-july9-march", targetId: "n-pres-house" },
    { id: "e7", sourceId: "n-july9-march", targetId: "n-social" },
    { id: "e8", sourceId: "n-gotagogama", targetId: "n-legal-aid" },
    { id: "e9", sourceId: "n-legal-aid", targetId: "n-hypothesis" },
    { id: "e10", sourceId: "n-reading", targetId: "n-hypothesis" },
    { id: "e11", sourceId: "n-maps", targetId: "n-hypothesis" },
    { id: "e-2dztvi", sourceId: "n-gotagogama", targetId: "n-june-fuel" },
    {
      id: "e-6f72b5",
      sourceId: "n-mar31-mirihana",
      targetId: "n-apr3-cabinet",
    },
    {
      id: "e-de80d0",
      sourceId: "n-apr3-cabinet",
      targetId: "n-apr9-gotagogama",
    },
    {
      id: "e-7c6d49",
      sourceId: "n-apr9-gotagogama",
      targetId: "n-apr19-rambukkana",
    },
    {
      id: "e-b22254",
      sourceId: "n-apr19-rambukkana",
      targetId: "n-may9-violence-pm-resigns",
    },
    {
      id: "e-60a975",
      sourceId: "n-may9-violence-pm-resigns",
      targetId: "n-jun27-fuel-halt",
    },
    {
      id: "e-cec486",
      sourceId: "n-jun27-fuel-halt",
      targetId: "n-jul9-storm-residence",
    },
    {
      id: "e-e4b9dd",
      sourceId: "n-jul9-storm-residence",
      targetId: "n-jul13-flee",
    },
    { id: "e-5d2322", sourceId: "n-jul13-flee", targetId: "n-jul14-resign" },
    {
      id: "e-87c4f4",
      sourceId: "n-jul14-resign",
      targetId: "n-jul20-ranil-elected",
    },
    {
      id: "e-cb9099",
      sourceId: "n-jul20-ranil-elected",
      targetId: "n-jul22-camp-raid",
    },
  ],
};

// --- helpers ---
function normTag(raw) {
  return String(raw || "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();
}

async function ensureTag(name) {
  const existing = await prisma.tag.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.tag.create({ data: { name } });
}

async function seedDemoBoard() {
  const existing = await prisma.board.findUnique({
    where: { id: demoBoard.id },
  });
  if (existing) {
    console.log(`Demo board '${demoBoard.id}' already exists. Skipping (no destructive changes).`);
    return;
  }

  await prisma.board.create({
    data: {
      id: demoBoard.id,
      title: demoBoard.title,
      schemaVersion: demoBoard.schemaVersion,
      visibility: demoBoard.visibility,
      status: demoBoard.status,
      userId: null,
    },
  });

  // Insert nodes
  for (const n of demoBoard.nodes) {
    const d = n.data || {};
    await prisma.node.create({
      data: {
        id: n.id,
        boardId: demoBoard.id,
        type: n.type,
        x: n.x ?? 0,
        y: n.y ?? 0,
        w: n.w ?? null,
        h: null,
        title: d.title || null,
        html: d.html || null,
        text: d.text || null,
        descHtml: d.descHtml || null,
        linkUrl: d.linkUrl || null,
        imageUrl: d.imageUrl || null,
      },
    });

    if (Array.isArray(d.tags) && d.tags.length) {
      for (const rawTag of d.tags) {
        const name = normTag(rawTag);
        if (!name) continue;
        const tag = await ensureTag(name);
        await prisma.nodeTag.create({
          data: {
            nodeId: n.id,
            tagId: tag.id,
          },
        });
      }
    }
  }

  // Insert edges
  for (const e of demoBoard.edges) {
    await prisma.edge.create({
      data: {
        id: e.id,
        boardId: demoBoard.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        label: e.label || null,
        dashed: false,
        color: null,
      },
    });
  }

  console.log(
    `Seeded demo board '${demoBoard.title}' with ${demoBoard.nodes.length} nodes and ${demoBoard.edges.length} edges.`
  );
}

async function main() {
  await seedDemoBoard();
}

try {
  await main();
} catch (err) {
  console.error("Seed failed:", err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
