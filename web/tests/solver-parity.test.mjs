import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { solve } from '../src/lib/solver.ts'
import { requestData } from './fixtures.mjs'

const python = fileURLToPath(new URL('../../backend/.venv/bin/python', import.meta.url))
const script = fileURLToPath(new URL('../../scripts/check_solver_parity.py', import.meta.url))

test('WASM objective and assignments agree with the independent Python reference', { skip: !existsSync(python) }, async () => {
  for (const change of [
    () => {},
    (r) => { r.options.balance_weight = 0 },
    (r) => { r.events[0].use_runners = true; r.events[0].num_runners_per_group = 1; r.competitors[0].is_staff = true; r.competitors[1].age = 12; r.competitors[4].is_newcomer = true; r.competitors[7].is_judge_exempt = true },
    (r) => { for (const p of r.competitors) p.events['333'].average_time = null },
    (r) => { r.num_stations = 2; r.competitors.pop() },
    (r) => { r.events.push({ ...r.events[0], event_id: '444' }); for (const p of r.competitors) p.events['444'] = { best_time: null, average_time: 100 + Number(p.competitor_id) } },
  ]) {
    const request = requestData(); change(request)
    const result = await solve(request)
    const reference = spawnSync(python, [script], { input: JSON.stringify({ request, assignments: result.assignments }), encoding: 'utf8', timeout: 30_000 })
    assert.equal(reference.status, 0, reference.stderr)
    const native = JSON.parse(reference.stdout)
    assert.deepEqual(native.validation_errors, [])
    assert.equal(native.status, 'OPTIMAL'); assert.equal(result.status, 'OPTIMAL')
    assert.equal(result.objective_value, native.objective_value)
  }
})
