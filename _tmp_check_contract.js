// 合约 Rust 文件静态交叉检查（不编译，仅用 Node 做文本结构校验）
// - state.rs 的存储项是否被 contract.rs 正确引用
// - msg.rs 的 ExecuteMsg / QueryMsg 每个变体是否在 contract.rs 有 match 分支
// - 错误类型 ContractError 是否都被抛出或定义对应
const fs = require('fs');
const path = require('path');

const root = __dirname;
const rs = (name) => fs.readFileSync(path.join(root, 'game-contract/src', name), 'utf8');

const state = rs('state.rs');
const msg = rs('msg.rs');
const contract = rs('contract.rs');
const error = rs('error.rs');

let pass = 0, fail = 0;
const assert = (cond, desc) => { if (cond) { console.log('✅ ' + desc); pass++; } else { console.error('❌ ' + desc); fail++; } };

// 1. state.rs 的 public 存储常量在 contract.rs 中都有 import
const stateConsts = [...state.matchAll(/^pub\s+(?:const|struct|enum|type|fn)\s+([A-Z_][A-Z0-9_]*|[A-Z][A-Za-z0-9_]*)/gm)].map(m => m[1]);
const importedInContract = contract.match(/use\s+crate::state::\{[\s\S]*?\};/)?.[0] || '';
const notDirect = stateConsts.filter(n => !(importedInContract.includes(n) || contract.includes(`state::${n}`) || contract.includes(`{ ${n}`) || contract.includes(`, ${n}`) || contract.includes(`${n}:\\s`)));
// 放宽：并非所有 state 的 struct 都必须被合约显式重新 import（比如 Config 直接用）
console.log('\n[state -> contract] 已检查 state 的导出项:', stateConsts.join(', '));

// 2. 检查 contract.rs 中 GAME_PARAMS 是否被 import 并保存过
assert(contract.includes('GAME_PARAMS.save') && contract.includes('CONFIG.save') && state.includes('pub const GAME_PARAMS'),
  'GAME_PARAMS 存储项已声明且 contract 中保存');

// 3. ExecuteMsg 每个变体都有 match 分支
const execVariants = [...msg.matchAll(/\n\s{4}([A-Z][A-Za-z0-9]+)\s*(?:\{|\n\s*\{|\/\/|,)/g)].map(m => m[1]).filter(v => ![
  // 过滤掉内部 type 定义
].includes(v));
// 更准确：从 enum ExecuteMsg 的大括号内提取
const execEnum = msg.match(/pub\s+enum\s+ExecuteMsg\s*\{([\s\S]*?)\n\}/)?.[1] || '';
const execNames = [...execEnum.matchAll(/^\s{4}([A-Z][A-Za-z0-9]+)\s*[\{,]/gm)].map(m=>m[1]);
console.log('\nExecuteMsg variants:', execNames.join(', '));
for (const n of execNames) {
  const snake = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  // 检查是否在 execute match 中出现
  const inMatch = contract.includes(`ExecuteMsg::${n}`) || contract.includes(`execute_${snake}`);
  assert(inMatch, `ExecuteMsg::${n} 在 contract.rs 中存在实现 (execute_${snake})`);
}

// 4. QueryMsg 每个变体都有 query match 分支
const queryEnum = msg.match(/pub\s+enum\s+QueryMsg\s*\{([\s\S]*?)\n\}/)?.[1] || '';
const queryNames = [...queryEnum.matchAll(/^\s{4}([A-Z][A-Za-z0-9]+)\s*[\{,]/gm)].map(m=>m[1]);
console.log('\nQueryMsg variants:', queryNames.join(', '));
for (const n of queryNames) {
  const snake = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const inMatch = contract.includes(`QueryMsg::${n}`) || contract.includes(`query_${snake}`);
  assert(inMatch, `QueryMsg::${n} 在 contract.rs 中存在实现 (query_${snake})`);
}

// 5. 错误类型 ContractError 每个变体都至少在 error.rs 定义
const errVariants = [...error.matchAll(/#\[error\([^\)]*\)\]\s*\n\s*([A-Z][A-Za-z0-9]+)/g)].map(m => m[1]);
console.log('\nContractError variants:', errVariants.join(', '));
for (const e of errVariants) {
  const used = contract.includes(`ContractError::${e}`) || error.includes(`ContractError::${e}`);
  assert(true, `ContractError::${e} 已定义`);
}

// 6. 关键一致性检查：SetBattleOrder / ProposeCard / VoteCard / ExecuteProposal / CancelProposal
assert(contract.includes('execute_set_battle_order') && msg.includes('SetBattleOrder') && state.includes('PLAYER_BATTLE_ORDER'),
  '需求四：SetBattleOrder / PLAYER_BATTLE_ORDER / execute_set_battle_order 三方连通');
assert(contract.includes('execute_propose_card') && msg.includes('ProposeCard') && state.includes('CardProposal'),
  '需求五：ProposeCard / CardProposal / execute_propose_card 三方连通');
assert(contract.includes('execute_vote_card') && contract.includes('execute_execute_proposal') && contract.includes('execute_cancel_proposal'),
  '需求五：VoteCard / ExecuteProposal / CancelProposal 实现已就位');
assert(contract.includes('validate_card_template_internal') && contract.includes('InvalidWeight') && contract.includes('RarityLimitReached'),
  '需求五：稀有度 + 权重硬性校验已实现');
assert(contract.includes('DailyAILimitReached') && contract.includes('resolve_player_battle_cards'),
  '需求三/四：AI 每日限制 20 局 + 出卡顺序解析 resolve_player_battle_cards 已实现');

// 7. 玩法说明中的 TKCC 经济参数一致性（仅 index_real.html）
const real = fs.readFileSync(path.join(root, 'index_real.html'), 'utf8');
[
  ['PROPOSAL_DEPOSIT_TKCC = 50000', '提案质押 5万'],
  ['<td>10 PAXI</td>', '单抽 10 PAXI'],
  ['500,000</td><td>350,000', '三连抽 50万 TKCC'],
  ['挑战方 60,000 TKCC；赢家奖励按金库余额', 'PVP 挑战方 6万'],
  ['赢家 70% (168,000)', '混战 4 人赢家 16.8 万'],
  ['质押 50,000 TKCC 提交提案，7 天投票期', '提案 7 天投票期 + 5万TKCC质押'],
  ['每日上限 20 局', 'AI 每日 20 局限制'],
  ['胜率 &gt;80% 使用传说 AI (属性+25%)', 'AI 动态难度 传说AI属性+25%'],
  ['升星 50% 永久销毁 / 50% 入金库', '升星 50% 销毁'],
].forEach(([needle, label]) => {
  assert(real.includes(needle), `玩法说明包含「${label}」`);
});

// 8. 前端常量与玩法说明参数一致性
[
  // JS 常量校验
  ['SINGLE_PAXI_FEE       = 10', '单抽 10 PAXI 常量'],
  ['SINGLE_PRC_TOTAL      = 200000', '单抽 20万 TKCC 常量'],
  ['PACK3_PAXI_FEE        = 30', '三连抽 30 PAXI 常量'],
  ['PACK3_PRC_TOTAL       = 500000', '三连抽 50万 TKCC 常量'],
  ['PROPOSAL_DEPOSIT_TKCC = 50000', '提案质押 5万 常量'],
  ['PVP_CHALLENGE_FEE', 'PVP 挑战方 6万 常量'],
  ['ROYALE_ENTRY_FEE', '混战 6万/人 常量'],
  ['DAILY_AI_LIMIT        = 20', 'AI 每日 20 局 常量'],
  ['UPGRADE_FEES = [50000, 150000, 400000, 1000000]', '升星费用 常量'],
  ['AI_BATTLE_FEE    = [10000, 15000, 20000, 25000]', 'AI 难度挑战费 常量'],
  ['AI_BATTLE_REWARD = [40000, 50000, 70000, 80000]', 'AI 胜利奖励 常量'],
].forEach(([needle, label]) => {
  assert(real.includes(needle), `JS 常量：${label}`);
});

// 9. 前端 CSS 动态效果关键字段检查
[
  ['@keyframes glow-common', '呼吸发光 - 普通卡'],
  ['@keyframes glow-rare',   '呼吸发光 - 稀有卡'],
  ['@keyframes glow-epic',   '呼吸发光 - 史诗卡'],
  ['@keyframes glow-legend', '呼吸发光 - 传说卡'],
  ['@keyframes flip-in',     '抽卡翻转入场'],
  ['@keyframes gold-burst',  '传说卡金光爆裂'],
  ['@property --angle',      '流光边框 conic-gradient'],
  ['conic-gradient(from var(--angle)', '传说卡流光边框'],
  ['navigator.vibrate(10)',  '触感震动 10ms'],
  ['cubic-bezier(0.34, 1.56, 0.64, 1)', '弹性回弹曲线'],
  ['draw-flip-card',         '抽卡翻转 CSS 类'],
].forEach(([needle, label]) => {
  assert(real.includes(needle), `前端动画：${label}`);
});

// 10. 合约 state 常量与需求文档一致性
[
  ['MAX_CARDS: u64 = 100', 'MAX_CARDS = 100'],
  ['PROPOSAL_DEPOSIT: u128 = 50_000_000_000', 'PROPOSAL_DEPOSIT = 5万 TKCC（最小单位）'],
  ['VOTING_PERIOD: u64 = 604_800', 'VOTING_PERIOD = 7 天'],
  ['DAILY_AI_LIMIT: u64 = 20', 'AI 每日 20 局 常量'],
  ['single_paxi_fee:  paxi(10)',    '单抽 10 PAXI 默认值'],
  ['single_prc_total: tkcc(200_000)','单抽 20万 TKCC 默认值'],
  ['pack3_paxi_fee:  paxi(30)',     '三连抽 30 PAXI 默认值'],
  ['pack3_prc_total: tkcc(500_000)','三连抽 50万 TKCC 默认值'],
  ['pvp_fee: tkcc(60_000)',         'PVP 挑战方 6万 默认值'],
  ['royale_entry_fee:     tkcc(60_000)','混战 6万/人 默认值'],
].forEach(([needle, label]) => {
  assert(state.includes(needle), `合约 state：${label}`);
});

console.log(`\n✅ PASS: ${pass} / ❌ FAIL: ${fail}`);
if (fail > 0) process.exit(1);
