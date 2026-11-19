import { readFile } from 'node:fs/promises';
import { Store } from './store.mjs';
import { Source } from './source.mjs';
import { prepare, resolve } from './numbers.mjs';
import { accept } from './printing.mjs';
import { present, assessIssue } from './quota.mjs';
import { planReopen, applyReopenResponse, applyReopenError, confirmDestruction, recordTrouble } from './reopen.mjs';

function recordSourceTrouble(state, parcelId, error) {
  if (error.status) applyReopenError(state, parcelId, error);
  else recordTrouble(state, parcelId, error.message);
  return present(state);
}

export async function createProduct({ sourceUrl, statePath = null }) {
  const config = JSON.parse(await readFile(new URL('./domain.json', import.meta.url), 'utf8'));
  const store = new Store(config.initial, statePath); await store.open();
  const source = new Source(sourceUrl, config.route);
  const routes = config.routes;

  async function issue(input) {
    return store.update(async state => {
      const request = prepare(state, input);
      const response = await source.request({ parcel: request.parcel, requestId: request.requestId }, routes.issue);
      const data = resolve(state, request, response);
      assessIssue(state, request, data);
      accept(state, request, data);
      return present(state);
    });
  }

  async function reopen(input) {
    const parcelId = input.parcel ?? 'P1';
    const plan = await store.update(state => planReopen(state, input, routes));
    if (plan === null) return store.update(state => present(state));
    let response;
    try {
      response = await source.request(plan.body, plan.route);
    } catch (error) {
      // 来源故障（断线/超时/业务拒绝）都在独立事务里落账，已办理进度不丢失、不半成品提交
      return store.update(state => recordSourceTrouble(state, parcelId, error));
    }
    await store.update(state => applyReopenResponse(state, parcelId, plan.route, response));
    return store.update(state => present(state));
  }

  return {
    async collect(input = {}) {
      if (input.action === 'reopen') return reopen(input);
      if (input.action === 'confirm-destruction') return store.update(async state => { confirmDestruction(state, input); return present(state); });
      return issue(input);
    },
    view() { return present(store.snapshot()); },
    receipts() { return source.receipts(); },
  };
}
