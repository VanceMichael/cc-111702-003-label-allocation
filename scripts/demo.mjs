import { readFile } from 'node:fs/promises';
import { startFixture } from '../src/fixture.mjs';
import { createProduct } from '../src/product.mjs';

const fixture = await startFixture(JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8')));
try {
  const product = await createProduct({ sourceUrl: fixture.url });
  const show = (title, view) => {
    const parcel = view.parcels[0];
    console.log(`【${title}】号码=${parcel.number ?? '无'} 阶段=${parcel.statusLabel} 可打印=${parcel.printable} 可交寄=${parcel.deliverable} 剩余额度=${view.remaining} 等待=${parcel.waitingOn.join('；') || '无'}`);
  };

  console.log('本地来源已就绪，先办理一次首次申领（保留原有用法）');
  show('首次申领', await product.collect({}));

  console.log('\n开始按包裹办理破损面单重开，每一步都可中断、可恢复：');
  show('打印通道核实', await product.collect({ action: 'reopen' }));
  show('承运平台核实', await product.collect({ action: 'reopen' }));
  show('现场销毁确认', await product.collect({ action: 'confirm-destruction' }));
  show('作废已受理', await product.collect({ action: 'reopen' }));
  show('作废仍在处理', await product.collect({ action: 'reopen' }));
  show('作废完成额度回收', await product.collect({ action: 'reopen' }));
  show('重新领号完成', await product.collect({ action: 'reopen' }));

  console.log('\n来源实际请求（不含授权原文）');
  console.log(JSON.stringify(fixture.calls, null, 2));
} finally {
  await fixture.close();
}
