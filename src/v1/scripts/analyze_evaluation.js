const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual, parseArgs } = require('node:util');

const root = path.resolve(__dirname, '../../..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const policies = ['policyAResult', 'policyBResult'];
const actions = ['SAFE', 'HOLD', 'FLAG'];

function calculateMetrics(pairs) {
    const counts = { TP: 0, FP: 0, FN: 0, TN: 0 };
    for (const [scam, flagged] of pairs) {
        counts[scam ? (flagged ? 'TP' : 'FN') : (flagged ? 'FP' : 'TN')]++;
    }
    const { TP, FP, FN, TN } = counts;
    return {
        ...counts,
        precision: TP + FP ? TP / (TP + FP) : null,
        recall: TP + FN ? TP / (TP + FN) : null,
        accuracy: pairs.length ? (TP + TN) / pairs.length : null,
    };
}

function analyze(resultPath) {
    const cases = readJson(path.join(root, 'data/evaluation-data.json'));
    const masked = readJson(path.join(root, 'data/evaluation-data-masked.json'));
    if (!isDeepStrictEqual(masked, cases.map(({ evaluation_id, messages }) => ({ evaluation_id, messages })))) {
        throw new Error('Labeled and masked evaluation datasets are not aligned.');
    }
    const entries = readJson(resultPath).flatMap(Object.entries);
    const results = Object.fromEntries(entries);
    const ids = cases.map(item => item.evaluation_id);
    if (new Set(ids).size !== ids.length || entries.length !== Object.keys(results).length ||
        entries.length !== cases.length || ids.some(id => !results[id])) {
        throw new Error('Missing, unknown, or duplicate evaluation results; use a complete run.');
    }

    const rows = cases.map(item => {
        if (!['scam', 'legitimate'].includes(item.ground_truth)) {
            throw new Error(`Invalid ground-truth label: ${item.evaluation_id}`);
        }
        const steps = results[item.evaluation_id];
        if (!steps.length || !isDeepStrictEqual(steps.map(step => step.time), item.messages.map(message => message.time))) {
            throw new Error(`Incomplete or out-of-order evaluation: ${item.evaluation_id}`);
        }
        const final = steps.at(-1);
        if (policies.some(policy => !actions.includes(final[policy]))) {
            throw new Error(`Invalid policy decision: ${item.evaluation_id}`);
        }
        return {
            evaluation_id: item.evaluation_id, source_case_id: item.source_case_id,
            ground_truth: item.ground_truth,
            policyAResult: final.policyAResult, policyBResult: final.policyBResult,
        };
    });

    return {
        result_file: resultPath,
        unit: 'final decision per conversation',
        positive_prediction: 'FLAG (SAFE and HOLD count as not flagged)',
        cases: rows.length,
        scam_cases: rows.filter(row => row.ground_truth === 'scam').length,
        policies: Object.fromEntries(policies.map(policy => [policy, {
            ...calculateMetrics(rows.map(row => [row.ground_truth === 'scam', row[policy] === 'FLAG'])),
            actions: Object.fromEntries(actions.map(action => [action, rows.filter(row => row[policy] === action).length])),
            missed_scam_ids: rows.filter(row => row.ground_truth === 'scam' && row[policy] !== 'FLAG').map(row => row.evaluation_id),
            false_positive_ids: rows.filter(row => row.ground_truth === 'legitimate' && row[policy] === 'FLAG').map(row => row.evaluation_id),
        }])),
        predictions: rows,
    };
}

function main() {
    const { values, positionals } = parseArgs({
        options: { output: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
        allowPositionals: true,
    });
    if (values.help) return console.log('Usage: pnpm analyze [result.json] [--output report.json]');
    if (positionals.length > 1) throw new Error('Expected at most one result file');
    const latest = fs.readdirSync(path.join(root, 'results'))
        .filter(file => /^evaluation-result-.*\.json$/.test(file)).sort().at(-1);
    if (!positionals[0] && !latest) throw new Error('No evaluation results found');
    const report = analyze(positionals[0] || path.join(root, 'results', latest));
    console.log(`Results: ${report.result_file}\nCases: ${report.cases} (${report.scam_cases} scam)`);
    console.log(`${report.unit}; ${report.positive_prediction}`);
    for (const [policy, metrics] of Object.entries(report.policies)) {
        console.log(`\n${policy}`);
        console.table({
            'Actual scam': { FLAG: metrics.TP, 'Not flagged': metrics.FN },
            'Actual legitimate': { FLAG: metrics.FP, 'Not flagged': metrics.TN },
        });
        for (const name of ['precision', 'recall', 'accuracy']) {
            console.log(`${name}: ${metrics[name] === null ? 'N/A' : (metrics[name] * 100).toFixed(2) + '%'}`);
        }
        console.log('Actions:', metrics.actions);
        console.log('Missed scams:', metrics.missed_scam_ids.join(', ') || 'none');
        console.log('False positives:', metrics.false_positive_ids.join(', ') || 'none');
    }
    if (values.output) fs.writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
}

module.exports = { analyze, calculateMetrics };
if (require.main === module) {
    try { main(); }
    catch (error) { console.error(`Analysis failed: ${error.message}`); process.exitCode = 1; }
}
