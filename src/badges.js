const { q } = require('./db');

const DEFS = [
  { id: 'trace_opener',  name: 'Trace Opener',   desc: 'Report your first found item to the bureau.', tier: 1, key: 'finds',     goal: 1  },
  { id: 'finders_eye',   name: "Finder's Eye",   desc: 'Report 5 found items.',                      tier: 2, key: 'finds',     goal: 5  },
  { id: 'field_scout',   name: 'Field Scout',    desc: 'Report 10 found items.',                     tier: 3, key: 'finds',     goal: 10 },
  { id: 'lifesaver',     name: 'Lifesaver',      desc: 'One of your finds was returned to its owner.', tier: 2, key: 'returned', goal: 1 },
  { id: 'guardian_angel', name: 'Guardian Angel', desc: 'Five of your finds have made it home.',       tier: 3, key: 'returned', goal: 5 },
  { id: 'case_filed',    name: 'Case Filed',     desc: 'File your first report for a lost item.',     tier: 1, key: 'lost',      goal: 1  },
  { id: 'homecoming',    name: 'Homecoming',     desc: 'Recover a lost item through an approved claim.', tier: 2, key: 'recovered', goal: 1 }
];

async function statsFor(userId) {
  const rows = await q(`
    SELECT
      (SELECT COUNT(*) FROM items WHERE finder_id = ?)                         AS finds,
      (SELECT COUNT(*) FROM items WHERE finder_id = ? AND status = 'returned') AS returned,
      (SELECT COUNT(*) FROM lost_reports WHERE student_id = ?)                 AS lost,
      (SELECT COUNT(*) FROM claims WHERE claimant_id = ? AND status = 'approved') AS recovered
  `, [userId, userId, userId, userId]);
  return rows[0] || { finds: 0, returned: 0, lost: 0, recovered: 0 };
}

function evaluate(stats) {
  const list = DEFS.map((d) => {
    const cur = Math.min(stats[d.key] || 0, d.goal);
    return {
      id: d.id, name: d.name, desc: d.desc, tier: d.tier,
      earned: cur >= d.goal,
      cur, goal: d.goal,
      progress: Math.round((cur / d.goal) * 100)
    };
  });
  return {
    total: list.length,
    earned: list.filter((b) => b.earned).length,
    list,
    earnedIds: list.filter((b) => b.earned).map((b) => b.id)
  };
}

module.exports = { DEFS, statsFor, evaluate };