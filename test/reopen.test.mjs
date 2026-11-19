import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../src/fixture.mjs';
import { createProduct } from '../src/product.mjs';
import { startProduct } from '../src/server.mjs';
import { heldQuota, assessIssue } from '../src/quota.mjs';

const baseScript = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const step = body => ({ body });
const route = (method, path, responses) => ({ method, path, responses });
const issueBody = { requestId: 'R1', parcel: 'P1', number: 'N1', quotaDebit: 1, remaining: 4, jobId: 'J1', printed: true };
const reissueBody = { requestId: 'R-P1-REOPEN', parcel: 'P1', number: 'N2', quotaDebit: 1, remaining: 4, jobId: 'J2', printed: false };

function makeScript({ issue = issueBody, print = { jobId: 'J1', number: 'N1', printed: true }, label = { number: 'N1', parcel: 'P1', handover: false, status: 'active' }, voidSteps, voidStatuses, reissueSteps } = {}) {
  return {
    routes: [
      route('POST', '/labels', [step(issue), ...(reissueSteps ?? [step(reissueBody)])]),
      route('POST', '/labels/N1/void', voidSteps ?? [step({ voidRequest: 'V1', number: 'N1', status: 'pending' })]),
      route('GET', '/voids/V1', voidStatuses ?? [step({ voidRequest: 'V1', number: 'N1', status: 'completed', quotaReturned: true })]),
      route('POST', '/print-receipts', [step(print)]),
      route('GET', '/labels/N1', [step(label)]),
    ],
  };
}

async function withFixture(script, operation) {
  const fixture = await startFixture(structuredClone(script));
  try { return await operation(fixture); } finally { await fixture.close(); }
}

// 调用方负责在用完后关闭 fixture（产品与来源服务的生命周期需要覆盖整个用例）
async function driveToVoidPending(script) {
  const fixture = await startFixture(structuredClone(script));
  const product = await createProduct({ sourceUrl: fixture.url });
  await product.collect({});
  await product.collect({ action: 'reopen' }); // 打印核实
  await product.collect({ action: 'reopen' }); // 平台核实
  await product.collect({ action: 'confirm-destruction' }); // 现场销毁
  await product.collect({ action: 'reopen' }); // 作废受理
  return { product, fixture };
}

test('重开全链路：双核实、现场销毁、受理后轮询、回收后重领', async () => {
  await withFixture(baseScript, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    const issued = await product.collect({});
    assert.equal(issued.parcels[0].number, 'N1');
    assert.equal(issued.parcels[0].printable, false);

    let view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'verify-platform');
    assert.match(view.parcels[0].waitingOn[0], /承运平台/);
    assert.equal(view.parcels[0].printable, false);
    assert.equal(view.parcels[0].deliverable, false);

    view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'await-destruction');
    assert.match(view.parcels[0].waitingOn[0], /现场/);

    view = await product.collect({ action: 'confirm-destruction' });
    assert.equal(view.parcels[0].status, 'void-request');
    assert.equal(view.parcels[0].paperDestroyed, true);

    // 现场销毁只解决纸面问题，重复登记不产生新动作，也不改变平台号码状态
    const repeat = await product.collect({ action: 'confirm-destruction' });
    assert.equal(repeat.parcels[0].status, 'void-request');

    view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'void-pending');
    assert.equal(view.parcels[0].voidRequest, 'V1');
    assert.equal(view.remaining, 4); // 取消中的额度仍被占用，未提前释放
    assert.equal(view.pendingReturn, 1);

    view = await product.collect({ action: 'reopen' }); // 第一次轮询仍为 pending
    assert.equal(view.parcels[0].status, 'void-pending');
    assert.equal(view.remaining, 4);

    view = await product.collect({ action: 'reopen' }); // 第二次轮询完成、额度回收
    assert.equal(view.parcels[0].status, 'reissue-ready');
    assert.equal(view.parcels[0].number, null); // 旧号已失效，不再显示为可用
    assert.equal(view.remaining, 5);

    view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'done');    assert.equal(view.parcels[0].number, 'N2');
    assert.equal(view.parcels[0].printable, true);
    assert.equal(view.parcels[0].deliverable, true);
    assert.equal(view.remaining, 4);
    assert.equal(view.parcels[0].history.length, 2);
    assert.deepEqual(view.parcels[0].history[0], { number: 'N1', requestId: 'R1', jobId: 'J1', printed: true, handedOver: false, status: 'voided', quotaReturned: true, platformStatus: 'active' });

    const callsBefore = fixture.calls.length;
    await product.collect({ action: 'reopen' }); // 终态后重复办理不产生任何来源请求
    assert.equal(fixture.calls.length, callsBefore);
  });
});

test('未打印面单跳过现场销毁，直接进入作废', async () => {
  const script = makeScript({
    issue: { ...issueBody, printed: false },
    print: { jobId: 'J1', number: 'N1', printed: false },
  });
  await withFixture(script, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    await product.collect({});
    await product.collect({ action: 'reopen' });
    const view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'void-request');
    await assert.rejects(product.collect({ action: 'confirm-destruction' }), /不需要现场销毁确认/);
  });
});

test('延迟到达的打印回执确认已打印后，仍要求现场销毁', async () => {
  const script = makeScript({
    issue: { ...issueBody, printed: false },
    print: { jobId: 'J1', number: 'N1', printed: true },
  });
  await withFixture(script, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    await product.collect({});
    await product.collect({ action: 'reopen' });
    const view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'await-destruction');
    assert.equal(view.parcels[0].printed, true);
  });
});

test('平台核实已交寄：终态拒绝，原号保留但不可交寄，不另领号', async () => {
  const script = makeScript({ label: { number: 'N1', parcel: 'P1', handover: true, status: 'handed-over' } });
  await withFixture(script, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    await product.collect({});
    await product.collect({ action: 'reopen' });
    const view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'refused-handover');
    assert.equal(view.parcels[0].number, 'N1');
    assert.equal(view.parcels[0].deliverable, false);
    const callsBefore = fixture.calls.length;
    await product.collect({ action: 'reopen' });
    assert.equal(fixture.calls.length, callsBefore); // 终态不重试、不领新号
  });
});

test('作废接口以已交寄拒绝：进入终态且保留交寄事实', async () => {
  const script = makeScript({ voidSteps: [{ status: 409, body: { reason: 'already-handed-over', status: 'handed-over' } }] });
  await withFixture(script, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    await product.collect({});
    await product.collect({ action: 'reopen' });
    await product.collect({ action: 'reopen' });
    await product.collect({ action: 'confirm-destruction' });
    const view = await product.collect({ action: 'reopen' });
    assert.equal(view.parcels[0].status, 'refused-handover');
    assert.equal(view.parcels[0].handedOver, true);
    assert.equal(view.parcels[0].number, 'N1');
  });
});

test('断线后重进：认清原作废受理进度再继续，不重复作废、不另领号', async () => {
  const script = makeScript({ voidStatuses: [{ disconnect: true }, { body: { voidRequest: 'V1', number: 'N1', status: 'completed', quotaReturned: true } }] });
  const { product, fixture } = await driveToVoidPending(script);
  try {
    const troubled = await product.collect({ action: 'reopen' }); // 断线：不抛半成品，保持原阶段
    assert.equal(troubled.parcels[0].status, 'void-pending');
    assert.equal(troubled.parcels[0].voidRequest, 'V1');
    assert.ok(troubled.parcels[0].waitingOn.join().includes('作废'));

    const ready = await product.collect({ action: 'reopen' }); // 重试取 completed：作废完成、额度回收
    assert.equal(ready.parcels[0].status, 'reissue-ready');
    const done = await product.collect({ action: 'reopen' }); // 重新领号
    assert.equal(done.parcels[0].status, 'done');
    assert.equal(done.parcels[0].number, 'N2');
    const voidCalls = fixture.calls.filter(call => call.path === '/labels/N1/void');
    const issueCalls = fixture.calls.filter(call => call.method === 'POST' && call.path === '/labels');
    assert.equal(voidCalls.length, 1);
    assert.equal(issueCalls.length, 2); // 首次申领 + 一次重开，没有为返回成功重复领号
  } finally { await fixture.close(); }
});

test('重开最终失败：旧号不复活、不显示可交寄，终态不再办理', async () => {
  const script = makeScript({ reissueSteps: [{ status: 409, body: { reason: 'reissue-rejected' } }] });
  const { product, fixture } = await driveToVoidPending(script);
  try {
    await product.collect({ action: 'reopen' }); // 轮询：作废完成、额度回收，进入 reissue-ready
    await product.collect({ action: 'reopen' }); // 重领被平台拒绝
    const failed = product.view();
    assert.equal(failed.parcels[0].status, 'reissue-failed');
    assert.equal(failed.parcels[0].number, null);
    assert.equal(failed.parcels[0].printable, false);
    assert.equal(failed.parcels[0].deliverable, false);
    const callsBefore = fixture.calls.length;
    await product.collect({ action: 'reopen' });
    assert.equal(fixture.calls.length, callsBefore);
  } finally { await fixture.close(); }
});

test('作废核实中的额度不得借给其他申请，回收后才可再用', () => {
  const state = {
    capacity: 1,
    parcels: { P1: { number: 'N1', jobId: 'J1', printed: true, handedOver: false, reopen: { phase: 'void-pending' }, history: [{ number: 'N1', status: 'active', quotaReturned: false }] } },
    prints: { J1: { number: 'N1', printed: true } },
  };
  assert.equal(heldQuota(state), 1);
  assert.throws(() => assessIssue(state, { parcel: 'P2', requestId: 'R2' }, { requestId: 'R2', parcel: 'P2', number: 'N9', quotaDebit: 1, remaining: 0, jobId: 'J9', printed: false }), /额度/);
  state.parcels.P1.history[0].quotaReturned = true;
  assert.equal(heldQuota(state), 0);
  assert.doesNotThrow(() => assessIssue(state, { parcel: 'P2', requestId: 'R2' }, { requestId: 'R2', parcel: 'P2', number: 'N9', quotaDebit: 1, remaining: 0, jobId: 'J9', printed: false }));
});

test('多包裹互不阻塞：一个包裹核实中，另一个照常打印交寄', async () => {
  const script = {
    routes: [
      route('POST', '/labels', [step({ requestId: 'R1', parcel: 'P1', number: 'N1', quotaDebit: 1, remaining: 4, jobId: 'J1', printed: false }), step({ requestId: 'R2', parcel: 'P2', number: 'N2', quotaDebit: 1, remaining: 3, jobId: 'J2', printed: false })]),
      route('POST', '/print-receipts', [step({ jobId: 'J1', number: 'N1', printed: false })]),
      route('GET', '/labels/N1', [step({ number: 'N1', parcel: 'P1', handover: false, status: 'active' })]),
      route('POST', '/labels/N1/void', [step({ voidRequest: 'V1', number: 'N1', status: 'pending' })]),
      route('GET', '/voids/V1', [step({ voidRequest: 'V1', number: 'N1', status: 'pending', quotaReturned: false })]),
    ],
  };
  await withFixture(script, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    await product.collect({ parcel: 'P1', requestId: 'R1' });
    await product.collect({ parcel: 'P2', requestId: 'R2' });
    await product.collect({ action: 'reopen', parcel: 'P1' });
    const view = product.view();
    const p1 = view.parcels.find(item => item.parcel === 'P1');
    const p2 = view.parcels.find(item => item.parcel === 'P2');
    assert.equal(p1.status, 'verify-platform');
    assert.equal(p2.status, 'active');
    assert.equal(p2.printable, true);
    assert.equal(p2.deliverable, true);
    assert.deepEqual(p2.waitingOn, []);
  });
});

test('已分配或已失效号码不得再次分配', async () => {
  const script = structuredClone(baseScript);
  script.routes[0].responses = [
    step(issueBody),
    step({ requestId: 'R2', parcel: 'P2', number: 'N1', quotaDebit: 1, remaining: 3, jobId: 'J9', printed: false }),
  ];
  await withFixture(script, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    await product.collect({ parcel: 'P1', requestId: 'R1' });
    await assert.rejects(product.collect({ parcel: 'P2', requestId: 'R2' }), /已分配|已失效/);
  });
});

test('重开中途持久化，新进程认清原进度后续办，不重复作废', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reopen-'));
  const statePath = join(directory, 'state.json');
  try {
    await withFixture(baseScript, async fixture => {
      const first = await createProduct({ sourceUrl: fixture.url, statePath });
      await first.collect({});
      await first.collect({ action: 'reopen' });
      await first.collect({ action: 'reopen' });
      await first.collect({ action: 'confirm-destruction' });
      const pending = await first.collect({ action: 'reopen' });
      assert.equal(pending.parcels[0].status, 'void-pending');
    });
    await withFixture(baseScript, async fixture => {
      // 来源实例重启后响应序列回到第一条；按 requestId 幂等语义，重开请求得到的是重开号响应
      const resumeScript = {
        routes: [
          route('POST', '/labels', [step({ ...reissueBody, remaining: 4 })]),
          route('GET', '/voids/V1', [step({ voidRequest: 'V1', number: 'N1', status: 'pending', quotaReturned: false }), step({ voidRequest: 'V1', number: 'N1', status: 'completed', quotaReturned: true })]),
        ],
      };
      const fixture2 = await startFixture(resumeScript);
      try {
        const second = await createProduct({ sourceUrl: fixture2.url, statePath });
        assert.equal(second.view().parcels[0].status, 'void-pending');
        assert.equal(second.view().parcels[0].voidRequest, 'V1');
        await second.collect({ action: 'reopen' }); // pending
        await second.collect({ action: 'reopen' }); // completed
        const done = await second.collect({ action: 'reopen' });
        assert.equal(done.parcels[0].status, 'done');
        assert.equal(done.parcels[0].number, 'N2');
        assert.ok(!fixture2.calls.some(call => call.path === '/labels/N1/void'), '续办不得重新发起作废');
      } finally { await fixture2.close(); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('作废结论必须归属原受理请求，完成后旧号置空也不接受他号结论', async () => {
  const script = makeScript({
    voidStatuses: [
      step({ voidRequest: 'V1', number: 'N1', status: 'completed', quotaReturned: true }),
      step({ voidRequest: 'V1', number: 'OTHER', status: 'completed', quotaReturned: true }),
    ],
  });
  const { product, fixture } = await driveToVoidPending(script);
  try {
    const ready = await product.collect({ action: 'reopen' }); // 完成、旧号置空
    assert.equal(ready.parcels[0].status, 'reissue-ready');
    assert.equal(ready.parcels[0].number, null);
    // 再次续办应直接进入重领，而不是被他号作废结论带偏
    const done = await product.collect({ action: 'reopen' });
    assert.equal(done.parcels[0].status, 'done');
    assert.equal(done.parcels[0].number, 'N2');
  } finally { await fixture.close(); }
});

test('未知包裹不能重开，进行中的包裹不能重复首次申领', async () => {
  await withFixture(baseScript, async fixture => {
    const product = await createProduct({ sourceUrl: fixture.url });
    await assert.rejects(product.collect({ action: 'reopen', parcel: 'PX' }), /不能办理重开/);
    await product.collect({});
    await product.collect({ action: 'reopen' });
    await assert.rejects(product.collect({ parcel: 'P1' }), /已有申领记录/);
  });
});

test('HTTP 办理与查询呈现重开进度', async () => {
  await withFixture(baseScript, async fixture => {
    const service = await startProduct({ sourceUrl: fixture.url });
    try {
      const post = body => fetch(service.url + '/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await post({})).status, 200);
      const step1 = await (await post({ action: 'reopen' })).json();
      assert.equal(step1.parcels[0].status, 'verify-platform');
      const state = await (await fetch(service.url + '/state')).json();
      assert.deepEqual(state, step1);
    } finally { await service.close(); }
  });
});
