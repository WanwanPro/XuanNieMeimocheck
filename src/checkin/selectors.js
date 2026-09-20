// 站点 DOM 选择器集中管理。
//
// 站点改版时只需要改这一个文件，不用在流程代码里到处找选择器。
// 每个函数返回"候选定位器数组"，按优先级从高到低排列，命中即用。

// ---- 弹窗 / 引导蒙层 ----
export function guideCloseCandidates(page) {
  return [
    page.getByRole('button', { name: /^(关闭|跳过|知道了|×|✕|✖|x)$/i }),
    page.getByText('关闭', { exact: true }),
    page.locator('.van-overlay .van-icon-cross'),
    page.locator('.van-popup .van-icon-cross'),
    page.locator('.driver-popover-close-btn'),
    page.locator('.driver-popover button').filter({ hasText: /^(×|✕|✖|关闭)$/ }),
    page.locator('.close,.close-btn,.guide-close'),
    page.locator('button:visible, [role="button"]:visible, .close:visible, .close-btn:visible, .guide-close:visible')
      .filter({ hasText: /^(×|✕|✖|x)$/i }),
  ];
}

// ---- 登录入口 ----
export function loginEntryCandidates(page) {
  return [
    page.getByText('我已满18岁，开始登录吧！', { exact: true }),
    page.getByText('开始登录', { exact: true }),
    page.getByRole('button', { name: '开始登录' }),
  ];
}

export function profileTabCandidates(page) {
  return [
    page.getByText('我的', { exact: true }),
    page.locator('uni-view').filter({ hasText: /^我的$/ }),
  ];
}

export function passwordLoginCandidates(page) {
  return [
    page.getByText('密码登录', { exact: true }),
    page.getByText('切换密码登录', { exact: true }),
    page.getByText(/密码登录/),
  ];
}

/** 协议勾选框（<img class="select-box"> 位于 .services-box 内） */
export function agreementCandidates(page) {
  return [
    page.locator('.select-box'),
    page.locator('.services-box'),
  ];
}

export function loginSubmitCandidates(page) {
  return [
    page.getByRole('button', { name: '登录' }),
    page.getByText('登录', { exact: true }).last(),
    page.locator('button:visible, uni-button:visible').filter({ hasText: /^登录$/ }).last(),
  ];
}

// ---- 电量页 / 签到 ----
export function powerEntryCandidates(page) {
  return [
    page.getByText('领电量', { exact: true }),
    page.getByText('领取电量', { exact: true }),
    page.getByText('录取电量', { exact: true }),
    page.getByRole('button', { name: /^领(取)?电量$/ }),
    page.locator('button:visible, uni-button:visible, uni-view:visible').filter({ hasText: /^领(取)?电量$/ }).last(),
  ];
}

export function checkinRewardCandidates(page) {
  return [
    page.getByText(/签到奖励/),
    page.locator('text=签到奖励'),
  ];
}

export function checkinButtonCandidates(page) {
  return [
    page.getByText('领取奖励', { exact: true }).last(),
    page.getByRole('button', { name: /^领取奖励$/ }),
    page.locator('button:has-text("领取奖励")'),
    page.locator('uni-view').filter({ hasText: /^领取奖励$/ }).last(),
    page.getByText('立即签到', { exact: true }).last(),
    page.getByText('每日签到', { exact: true }).last(),
    page.getByText('签到领电量', { exact: true }).last(),
    page.getByRole('button', { name: /^(立即签到|每日签到|签到领电量|签到)$/ }),
    page.locator('button:visible, uni-button:visible, uni-view:visible').filter({ hasText: /^(立即签到|每日签到|签到领电量|签到)$/ }).last(),
  ];
}

export function claimButtonCandidates(page) {
  // 只接受明确的“领取奖励”，或在可见弹窗/对话框内精确文本为“领取/领取奖励”。
  // 不再对整个页面使用裸“领取”文本，避免误点其它活动奖励。
  const dialog = page.locator([
    '[role="dialog"]:visible',
    '.van-popup:visible',
    '.van-dialog:visible',
    '.uni-popup:visible',
    '.uni-modal:visible',
    '.modal:visible',
    '.popup:visible',
    '[class*="dialog"]:visible',
    '[class*="popup"]:visible',
  ].join(', '));
  return [
    dialog.getByRole('button', { name: /^领取(奖励)?$/ }),
    dialog.getByText('领取', { exact: true }).last(),
    dialog.getByText('领取奖励', { exact: true }).last(),
    page.getByRole('button', { name: /^领取奖励$/ }),
    page.getByText('领取奖励', { exact: true }).last(),
  ];
}

// ---- 状态文本判定 ----
export const TEXT = {
  loggedIn: ['领电量', '电量余额'],
  loggedOut: ['我已满18岁，开始登录吧！', '开始登录', '密码登录', '切换密码登录'],
  alreadyCheckedIn: /已签到|今日已签/,
  checkinDone: /已签到|签到成功|今日已签/,
  checkinReward: /签到奖励/,
};

// ---- 风控 / 人机校验特征 ----
export const RISK_PATTERNS = [
  /请完成(?:安全|人机|滑块|滑动|图形|短信|邮箱)?验证/,
  /验证码.{0,6}(?:失败|错误|不正确|过期|失效|有误)/,
  /(?:人机|安全|滑块|滑动|行为|真人)验证/,
  /操作过于频繁/,
  /访问受限/,
  /账号异常/,
  /异常访问/,
  /请稍后再试/,
];

export const RISK_SELECTORS = [
  '.geetest_holder',
  '.geetest_panel',
  '#captcha',
  '.captcha',
  '.verify-box',
  'iframe[src*="captcha"]',
  'iframe[src*="geetest"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]',
];
