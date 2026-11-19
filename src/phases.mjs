// 重开状态机阶段常量。独立模块，避免 reopen/quota/presentation 之间的循环依赖
export const PHASE = {
  VERIFY_PRINT: 'verify-print',        // 等打印回执通道核实
  VERIFY_PLATFORM: 'verify-platform',  // 等承运平台核实交寄/号码状态
  AWAIT_DESTRUCTION: 'await-destruction', // 等现场确认原纸销毁
  VOID_REQUEST: 'void-request',        // 发起平台作废
  VOID_PENDING: 'void-pending',        // 平台受理，等作废结论
  REISSUE_READY: 'reissue-ready',      // 作废完成、额度已回收，可重新领号
  DONE: 'done',
  REFUSED_HANDOVER: 'refused-handover',       // 终态：已交寄，平台不允许作废
  VOID_REJECTED: 'void-rejected',             // 终态：平台明确拒绝作废
  REISSUE_FAILED: 'reissue-failed',           // 终态：重开失败，旧号已失效
};

export const TERMINAL_PHASES = new Set([PHASE.DONE, PHASE.REFUSED_HANDOVER, PHASE.VOID_REJECTED, PHASE.REISSUE_FAILED]);
// 纯等待阶段：不向来源发起请求，等人或外部动作
export const HELD_PHASES = new Set([PHASE.AWAIT_DESTRUCTION]);
