// 本轮改动（B + D2 + I + R12）：「我的」页新增无感模式卡片 + 状态/到期提示；
//   hardReset 清空会话客户端缓存与内存私钥（I 修复）；
//   R12：①app.js/sanguo.js 的 Session.sign 调用补 await（C1 修复）②深链回退统一为官方 DApp 指南文档链接。
/**
 * Paxi Game Hub - 主入口
 * 路由 / 钱包 / 大厅 / 充提 / 游戏引导
 */

let currentTab = 'home';
let ctx = null;          // 当前游戏的上下文
let gameClaimBal = '0';  // 游戏页「领取奖励」卡片的合约内余额（下注用的是 TKCC）
let autoBetStop = false; // 2026-09-29 P1-7：连续下注停止标志

// ============================================================
// 日志
// ============================================================
function log(msg, type = '') {
  const el = document.getElementById('log');
  if (!el) return;
  const line = document.createElement('div');
  line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function showBusy(text) {
  hideBusy();
  const m = document.createElement('div');
  m.className = 'mask';
  m.id = 'busyMask';
  m.innerHTML = `<div class="spinner"></div><div>${text || hubT('processing')}</div>`;
  document.body.appendChild(m);
}
function hideBusy() {
  const m = document.getElementById('busyMask');
  if (m) m.remove();
}

const $ = (id) => document.getElementById(id);

// ============================================================
// 多语言（大厅级；三国子系统在自己的 sanguo.js 中响应 hub-lang-change）
// ============================================================
const HUB_I18N = {
  zh: {
    tab_home: '游戏', tab_wallet: '钱包', tab_me: '我的',
    btn_connect: '连接',
    title_home: '游戏大厅', title_wallet: '钱包', title_me: '我的',
    banner_title: '⚠️ 尚未配置游戏合约',
    banner_desc: '合约还没编译部署，所以地址没有写死。等合约 store + instantiate 拿到地址后，在「我的 → 合约地址」填一次即可，之后永久生效。也可以用带参数链接：',
    banner_tip: '💡 默认使用 TKCC 代币下注（需先「充值」TKCC 到合约）',
    banner_btn: '去填写合约地址',
    all_games: '全部游戏',
    choice_title: '🎮 选择游戏',
    w_bal_title: '💰 余额',
    sel_token: '选择代币',
    dep_title: '⬇️ 充值到合约',
    wd_title: '⬆️ 提款到钱包',
    sess_title: '🔑 会话密钥',
    add_token: '＋ 添加 PRC-20 代币',
    log_title: '📋 日志',
    acc_title: '👤 账户',
    contract_title: '📄 合约地址',
    limit_title: '🎮 游戏限额',
    limit_compliance: '本应用为合规休闲卡牌版，不含任何押注/博彩游戏，故无下注限额。',
    reset_session: '清除本地会话密钥',
    dep_btn: '充值', wd_btn: '提现', save_btn: '保存并刷新',
    menu_deposit: '💰 充值', menu_withdraw: '💳 提现',
    menu_pump: '🚀 个性化发币', menu_burn: '🔥 燃烧代币', menu_reset: '🔄 重置数据',
    menu_economy: '📖 玩法及经济说明',
    // —— 玩法及经济说明弹窗 / 卡牌弹窗（静态 UI 文案）——
    menu_settings: '设置',
    eco_title: '📖 玩法及经济说明',
    codex_title: '卡牌图鉴',
    detail_rarity: '稀有度', detail_faction: '阵营', detail_atk: '攻击',
    detail_def: '防御', detail_total: '共计', detail_star: '⭐ 星级',
    btn_star_up: '⭐ 升1星', btn_star_frag: '✨ 碎片升星', btn_level_up: '💠 升级',
    btn_decompose: '🔥 分解', btn_close: '关闭', modal_processing: '处理中...',
    // —— 通用 ——
    processing: '处理中…', loading: '加载中…', back_home: '← 大厅', back_wallet: '← 钱包',
    not_deployed: '合约未部署', pending_deploy: '🔒 待部署', disabled: '已停用',
    tag_external: '🎁 外部应用 · 新窗口打开',
    hint_connect: '连接钱包后即可开始游戏',
    hint_register: '首次游戏需注册会话密钥（一次性，之后下注不再弹钱包）',
    bal_onchain_paxi: '链上 PAXI', bal_incontract_paxi: '合约内 PAXI', bal_incontract_tkcc: '合约内 TKCC',
    // —— 钱包页 ——
    wallet_bal: '钱包余额', incontract_bal: '合约内余额', amt_label: '数量', all_btn: '全部',
    wallet_compliance_title: '💰 PAXI 钱包',
    wallet_compliance_note: '合规版不含下注/博彩：买卡与买碎片用钱包 PAXI 直接支付，无需充值到合约，也没有 TKCC 内部余额。会话密钥用于免密签名游戏操作（抽卡/购买/关卡）。',
    topup_title: '⚡ 给会话充值 PAXI',
    topup_sess_bal: '会话地址 PAXI',
    topup_btn: '充值到会话',
    topup_desc: '买卡 / 买碎片由会话地址免密支付（PAXI）。会话地址余额不足时先在这里充值——只弹 1 次主钱包，之后购买继续全免密。',
    topup_done: '✅ 充值成功，现在可以去商店买卡/碎片了',
    topup_bad_amt: '请输入大于 0 的金额',
    topup_no_session: '尚未注册会话密钥，请先在下方注册会话',
    contract_addr_label: '合约地址',
    dep_desc_cw20: 'PRC-20 充值分两步：先<b>授权</b>给游戏合约，再充值。授权不足时会自动先发授权交易。',
    dep_desc_native: '充值后可在游戏中直接下注，无需每次签名。',
    sess_status: '状态', sess_unregistered: '未注册', sess_expired: '已过期', sess_ok: '正常',
    sess_addr: '会话地址', sess_daily_quota: '今日额度',
    sess_renew: '续期会话（+24h）', sess_register: '注册会话密钥',
    sess_desc: '会话有效期 24 小时。注册后下注由本地密钥签名，不再弹钱包。',
    // —— 我的页 ——
    acc_wallet_addr: '钱包地址', acc_sess_addr: '会话地址', acc_chain_id: '链 ID',
    acc_game_contract: '游戏合约', not_configured: '未配置',
    contract_game_label: '游戏合约地址',
    contract_tkcc_label: 'TKCC 合约（可选）',
    contract_desc: '填一次即写入本地，之后打开都不用再填。也可以直接用链接带参数打开：',
    clear_contracts_btn: '清除本地地址（回到默认值）',
    no_games_configured: '合约尚未配置任何游戏',
    load_fail: '读取失败：',
    per_day: '日', rounds_unit: '局',
    reset_session_desc: '仅在 nonce 卡死或想换密钥时使用。清除后需重新注册会话。',
    // —— 无感模式卡片（2026-09-29 补 i18n，原先为硬编码中文）——
    seamless_title: '🔓 无感模式',
    seamless_status: '状态',
    seamless_feegrant: 'gas 代付授权',
    seamless_bal: '会话余额',
    seamless_expiry: '到期时间',
    seamless_checking: '检测中…',
    seamless_enable_btn: '开启无感模式（免密）',
    seamless_renew_btn: '续期 / 重新授权无感模式',
    seamless_selfcheck_btn: '🔍 无感自检（出问题先点这个）',
    seamless_desc: '开启后游戏操作（抽卡 / 对战 / 迁移）不再弹钱包，gas 由主钱包代付 7 天；若代付授权不可用，会话账户会用自带的 PAXI 余额付费，同样免密。充值 / 提现 / 管理员操作不受影响。',
    seamless_st_ok: '正常（免密可用）',
    seamless_st_off: '未开启 / 已过期',
    seamless_st_expiring: '即将到期',
    seamless_st_nogas: '会话有效，但无法付 gas',
    seamless_fg_valid: '有效',
    seamless_fg_queryfail: '查询失败',
    seamless_fg_none: '未授权 / 已过期',
    seamless_hours: (h) => `${h} 小时后`,
    seamless_fg_detail: (amt) => `（额度 ${amt} PAXI，主钱包代付）`,
    seamless_bal_detail: (bal, per) => `${bal} PAXI（每笔约 ${per}）`,
    seamless_bal_plain: (bal) => `${bal} PAXI`,
    seamless_busy: '授权中…（只需在钱包确认 1 次）',
    seamless_ok_toast: '无感模式已开启，之后游戏操作不再弹钱包',
    seamless_fail_toast: '开通失败',
    seamless_checkfail: (m) => `自检失败：${m}`,
    // —— 无感自检条目（session.js selfCheck 用，原先为硬编码中文）——
    sc_unknown: '未知',
    sc_build: '页面版本 build',
    sc_build_old: (b) => `${b}（⚠️ 不是最新版，浏览器可能缓存了旧脚本，请强制刷新）`,
    sc_cosmjs: 'CosmJS 签名库',
    sc_loaded: '已加载', sc_notloaded: '未加载，无感签名无法工作',
    sc_noble: '加密库 noble',
    sc_wallet: '主钱包', sc_notconnected: '未连接',
    sc_chainid: 'chainId',
    sc_mingas: '链上最低 gas 价',
    sc_mingas_detail: (g) => `${g} upaxi/gas（无感通道按此付费）`,
    sc_feerate: '单笔手续费',
    sc_feerate_detail: (a, d, g) => `${a}${d} / gas ${g}`,
    sc_calc_fail: '计算失败',
    sc_sesskey: '本地会话密钥',
    sc_sesskey_detail: (a) => `地址 ${a}`, sc_sesskey_none: '无（将重新生成）',
    sc_sessreg: '合约侧会话注册',
    sc_sessreg_detail: (m, h, n) => `已注册，公钥${m ? '匹配' : '❌不匹配'}，剩余 ${h} 小时，nonce=${n}`,
    sc_sessreg_none: '未注册，需要开启无感模式',
    sc_sessbal: '会话账户 PAXI 余额',
    sc_sessbal_detail: (b) => `${b} PAXI（仅作兜底，正常由主钱包代付）`,
    sc_feegrant: '链上 gas 代付授权(Feegrant)',
    sc_fg_valid_detail: (s, e) => `有效，额度 ${s} PAXI，到期 ${e}`,
    sc_invalid: '无效',
    sc_fg_unknown: '（查询失败，可能是网络问题）',
    sc_fg_queryfail: '查询失败',
    sc_verdict: '无感通道最终判定',
    sc_verdict_feegrant: '✅ 可用（主钱包代付 gas）',
    sc_verdict_selfpay: '✅ 可用（会话余额自付 gas）',
    sc_verdict_fail: (r) => `❌ 不可用：${r}`,
    sc_lasterr: '上次无感失败原因',
    sc_exception: '异常',
    acc_build_unknown: '未知（旧版缓存）',
    seamless_check_failed: '检查失败',
    // —— 游戏页 ——
    result_title: '🎰 结果', result_placeholder: '下注后显示结果',
    // —— 本局链上明细（2026-09-28 新增：解释"钱包只显示其中一条转账"）——
    bd_title: '🧾 本局链上明细',
    bd_bet: '下注', bd_burn: '销毁', bd_treasury: '运营', bd_pool: '奖池准备金',
    bd_payout: '派彩（含本金）', bd_profit: '净赚',
    bd_txhash: '交易哈希', bd_height: '区块高度',
    bd_win_note: '赢局不扣费：本金原路留在合约内余额，净赚部分从奖池准备金支付。',
    bd_note: '⚠️ 钱包 App 的转账记录通常只显示上面的「运营」一条 —— 它是本局唯一产生的 cw20 转账，并不等于你的下注金额。下注与奖池走合约内部记账、销毁走 cw20 burn，都不产生转账事件，请以链上事件 / 区块浏览器为准。',
    bet_title: '💵 下注', bet_min: '最小', bet_max: '最大', bet_x2: '翻倍', bet_half: '减半',
    btn_play: '开始游戏', btn_submitting: '提交中…',
    limit_single: '单局限额', limit_daily: '每日上限',
    // —— 2026-09-29 P1-5/6/7：历史·下注面板·连续下注 ——
    hist_title: '📜 最近对局', hist_empty: '暂无记录', hist_win: '赢', hist_lose: '输',
    hist_bet: '下注', hist_payout: '派彩', hist_result: '结果', hist_time: '时间',
    stat_today: '今日输赢', stat_streak: '连胜', stat_total_bet: '总下注', stat_roi: '回报率',
    bet_slider: '滑动调整', bet_pct: '比例', bet_est: '预计最大派彩', bet_daily_left: '今日剩余可下',
    chip_10: '10', chip_50: '50', chip_100: '100', chip_500: '500',
    auto_title: '🔁 连续下注', auto_n: '局数', auto_start: '开始自动', auto_stop: '停止',
    auto_progress: '进度', auto_done: '自动下注结束', auto_stopped: '已停止',
    // —— 游戏页「领取奖励」（大厅游戏赢的币即时进合约内部余额，需在此提现回钱包）——
    claim_title: '🎁 领取奖励',
    claim_desc: '本游戏赢的币会先记在<b>合约内部余额</b>，不会自动到钱包。点下方按钮即可全部取回钱包（也可部分提现）。',
    claim_btn: '全部取回',
    claim_empty: '合约内暂无可领取的余额',
    claim_loading: '查询中…',
    claim_ok: '领取成功',
    // —— 提示 ——
    toast_open_in_paxihub: '请在 PaxiHub 钱包内打开',
    toast_connected: '钱包已连接',
    toast_connect_fail: '连接失败：',
    toast_set_contract_first: '请先在「我的」填写合约地址',
    toast_input_amount: '请输入下注金额',
    toast_invalid_amount: '数量无效', toast_input_amount_dep: '请输入数量',
    toast_added: '已添加', toast_removed: '已移除',
    tkcc_missing: '未配置 TKCC 合约，请先在「我的」填写',
    connect_wallet_first: '请先连接钱包',
    register_session_busy: '注册会话…',
    sess_registered_ok: '会话已注册', sess_register_ok2: '注册成功',
    wallet_insufficient: '钱包余额不足',
    game_insufficient: '合约内余额不足',
    load_game_busy: '加载游戏…',
    register_first_hint: '注册会话密钥后即可开始游戏（一次性操作，之后下注不再弹钱包）。',
    ready_log: (name, engine) => `${name} 已就绪，引擎 ${engine}`,
    load_fail_log: '加载失败：',
    fail_log: '失败：',
    chain_ok_log: '已上链，高度',
    you_win: '🎉 赢', you_lose: '😢 输',
    won_log: (v) => `🎉 赢了！派彩 ${v} TKCC`,
    lose_log: (v) => `输了 ${v} TKCC`,
    bet_log: (a, n) => `下注 ${a} TKCC（nonce=${n}）`,
    below_min_bet: (v) => `低于最小下注 ${v} TKCC`,
    above_max_bet: (v) => `超过最大下注 ${v} TKCC`,
    engine_mismatch: (want, got) => `引擎不匹配：本页期望 "${want}"，合约绑的是 "${got}"`,
    game_not_configured: (id) => `合约未配置游戏 "${id}" 的引擎`,
    limit_not_configured: (id) => `合约未配置游戏 "${id}" 的限额`,
    game_disabled: (id) => `游戏 "${id}" 已停用`,
  },
  en: {
    tab_home: 'Game', tab_wallet: 'Wallet', tab_me: 'Me',
    btn_connect: 'Connect',
    title_home: 'Game Hub', title_wallet: 'Wallet', title_me: 'My Account',
    banner_title: '⚠️ Game contract not configured',
    banner_desc: "The contract isn't compiled/deployed yet, so addresses aren't hardcoded. After store + instantiate, fill the address once in \"My → Contract\" and it persists. You can also open with a param link:",
    banner_tip: '💡 Bets use TKCC by default (deposit TKCC to the contract first)',
    banner_btn: 'Go set contract address',
    all_games: 'All Games',
    choice_title: '🎮 Choose a Game',
    w_bal_title: '💰 Balance',
    sel_token: 'Select Token',
    dep_title: '⬇️ Deposit to Contract',
    wd_title: '⬆️ Withdraw to Wallet',
    sess_title: '🔑 Session Key',
    add_token: '＋ Add PRC-20 Token',
    log_title: '📋 Log',
    acc_title: '👤 Account',
    contract_title: '📄 Contract Address',
    limit_title: '🎮 Game Limits',
    limit_compliance: 'This is the compliance casual card edition — no wagering/gambling games, so there are no bet limits.',
    reset_session: 'Clear Local Session Key',
    dep_btn: 'Deposit', wd_btn: 'Withdraw', save_btn: 'Save & Reload',
    menu_deposit: '💰 Deposit', menu_withdraw: '💳 Withdraw',
    menu_pump: '🚀 Personal Token', menu_burn: '🔥 Burn Token', menu_reset: '🔄 Reset Data',
    menu_economy: '📖 Gameplay & economy',
    // —— economy / card modals (static UI text) ——
    menu_settings: 'Settings',
    eco_title: '📖 Gameplay & Economy',
    codex_title: 'Card Codex',
    detail_rarity: 'Rarity', detail_faction: 'Faction', detail_atk: 'ATK',
    detail_def: 'DEF', detail_total: 'Total', detail_star: '⭐ Star',
    btn_star_up: '⭐ +1 Star', btn_star_frag: '✨ Fragment Star', btn_level_up: '💠 Level Up',
    btn_decompose: '🔥 Decompose', btn_close: 'Close', modal_processing: 'Processing...',
    // —— common ——
    processing: 'Processing…', loading: 'Loading…', back_home: '← Hub', back_wallet: '← Wallet',
    not_deployed: 'Contract not deployed', pending_deploy: '🔒 Pending', disabled: 'Disabled',
    tag_external: '🎁 External app · opens in new tab',
    hint_connect: 'Connect your wallet to start playing',
    hint_register: 'First-time players need to register a session key (one-time; bets then skip wallet popups)',
    bal_onchain_paxi: 'On-chain PAXI', bal_incontract_paxi: 'In-contract PAXI', bal_incontract_tkcc: 'In-contract TKCC',
    // —— wallet page ——
    wallet_bal: 'Wallet Balance', incontract_bal: 'In-contract Balance', amt_label: 'Amount', all_btn: 'Max',
    wallet_compliance_title: '💰 PAXI Wallet',
    wallet_compliance_note: 'This compliance edition has no wagering/gambling: buying cards and fragments is paid directly from your PAXI wallet — no deposit to contract, no TKCC internal balance. The session key signs game actions (draw / purchase / stage) fee-free.',
    topup_title: '⚡ Top Up Session PAXI',
    topup_sess_bal: 'Session PAXI',
    topup_btn: 'Top Up Session',
    topup_desc: 'Card/fragment purchases are paid fee-free by the session address (PAXI). If the session balance is low, top it up here — one wallet popup, then purchases stay fully seamless.',
    topup_done: '✅ Top-up successful — you can now buy cards/fragments in the Shop',
    topup_bad_amt: 'Enter an amount greater than 0',
    topup_no_session: 'Session key not registered yet — register the session first below',
    contract_addr_label: 'Token Contract',
    dep_desc_cw20: 'PRC-20 deposits take two steps: <b>approve</b> the game contract first, then deposit. Approval is sent automatically when insufficient.',
    dep_desc_native: 'After depositing you can bet directly in games without wallet popups.',
    sess_status: 'Status', sess_unregistered: 'Not registered', sess_expired: 'Expired', sess_ok: 'Active',
    sess_addr: 'Session Address', sess_daily_quota: 'Today\'s Quota',
    sess_renew: 'Renew Session (+24h)', sess_register: 'Register Session Key',
    sess_desc: 'Sessions last 24 hours. After registering, bets are signed locally — no wallet popups.',
    // —— my account page ——
    acc_wallet_addr: 'Wallet Address', acc_sess_addr: 'Session Address', acc_chain_id: 'Chain ID',
    acc_game_contract: 'Game Contract', not_configured: 'Not set',
    contract_game_label: 'Game Contract Address',
    contract_tkcc_label: 'TKCC Contract (optional)',
    contract_desc: 'Fill once and it persists locally. You can also open with a param link:',
    clear_contracts_btn: 'Clear Local Addresses (back to defaults)',
    no_games_configured: 'No games configured in the contract yet',
    load_fail: 'Load failed: ',
    per_day: '/day', rounds_unit: ' rounds',
    reset_session_desc: 'Only use when the nonce is stuck or you want new keys. You must re-register the session afterwards.',
    // —— seamless mode card (added 2026-09-29; previously hardcoded Chinese) ——
    seamless_title: '🔓 Seamless Mode',
    seamless_status: 'Status',
    seamless_feegrant: 'Gas Sponsorship',
    seamless_bal: 'Session Balance',
    seamless_expiry: 'Expires',
    seamless_checking: 'Checking…',
    seamless_enable_btn: 'Enable Seamless Mode (no password)',
    seamless_renew_btn: 'Renew / Re-authorize Seamless',
    seamless_selfcheck_btn: '🔍 Seamless Self-Check (try this first)',
    seamless_desc: 'Once enabled, game actions (draw / battle / migrate) no longer prompt the wallet — gas is paid by your main wallet for 7 days. If sponsorship is unavailable, the session account pays from its own PAXI balance, still without prompts. Deposit / withdraw / admin actions are unaffected.',
    seamless_st_ok: 'OK (no password needed)',
    seamless_st_off: 'Not enabled / expired',
    seamless_st_expiring: 'Expiring soon',
    seamless_st_nogas: 'Session valid, but cannot pay gas',
    seamless_fg_valid: 'Valid',
    seamless_fg_queryfail: 'Query failed',
    seamless_fg_none: 'Not authorized / expired',
    seamless_hours: (h) => `in ${h} hours`,
    seamless_fg_detail: (amt) => `(limit ${amt} PAXI, paid by main wallet)`,
    seamless_bal_detail: (bal, per) => `${bal} PAXI (~${per} per tx)`,
    seamless_bal_plain: (bal) => `${bal} PAXI`,
    seamless_busy: 'Authorizing… (confirm once in wallet)',
    seamless_ok_toast: 'Seamless mode enabled — game actions no longer prompt the wallet',
    seamless_fail_toast: 'Failed to enable',
    seamless_checkfail: (m) => `Self-check failed: ${m}`,
    // —— seamless self-check items (used by session.js selfCheck; previously hardcoded Chinese) ——
    sc_unknown: 'Unknown',
    sc_build: 'Page build',
    sc_build_old: (b) => `${b} (⚠️ not the latest — the browser may have cached old scripts, force refresh)`,
    sc_cosmjs: 'CosmJS signing lib',
    sc_loaded: 'Loaded', sc_notloaded: 'Not loaded — seamless signing will not work',
    sc_noble: 'noble crypto lib',
    sc_wallet: 'Main wallet', sc_notconnected: 'Not connected',
    sc_chainid: 'chainId',
    sc_mingas: 'On-chain min gas price',
    sc_mingas_detail: (g) => `${g} upaxi/gas (seamless channel pays this)`,
    sc_feerate: 'Fee per tx',
    sc_feerate_detail: (a, d, g) => `${a}${d} / gas ${g}`,
    sc_calc_fail: 'Calculation failed',
    sc_sesskey: 'Local session key',
    sc_sesskey_detail: (a) => `address ${a}`, sc_sesskey_none: 'None (will regenerate)',
    sc_sessreg: 'On-chain session registration',
    sc_sessreg_detail: (m, h, n) => `Registered, pubkey ${m ? 'matches' : '❌ mismatch'}, ${h} hours left, nonce=${n}`,
    sc_sessreg_none: 'Not registered — enable seamless mode',
    sc_sessbal: 'Session account PAXI balance',
    sc_sessbal_detail: (b) => `${b} PAXI (fallback only; normally paid by main wallet)`,
    sc_feegrant: 'On-chain gas sponsorship (Feegrant)',
    sc_fg_valid_detail: (s, e) => `Valid, limit ${s} PAXI, expires ${e}`,
    sc_invalid: 'Invalid',
    sc_fg_unknown: '(query failed, possibly a network issue)',
    sc_fg_queryfail: 'Query failed',
    sc_verdict: 'Seamless channel verdict',
    sc_verdict_feegrant: '✅ Available (gas paid by main wallet)',
    sc_verdict_selfpay: '✅ Available (gas paid by session balance)',
    sc_verdict_fail: (r) => `❌ Unavailable: ${r}`,
    sc_lasterr: 'Last seamless failure reason',
    sc_exception: 'Exception',
    acc_build_unknown: 'Unknown (cached old version)',
    seamless_check_failed: 'Check failed',
    // —— game page ——
    result_title: '🎰 Result', result_placeholder: 'Result shows after betting',
    bd_title: '🧾 On-chain breakdown',
    bd_bet: 'Bet', bd_burn: 'Burned', bd_treasury: 'Treasury', bd_pool: 'House bankroll',
    bd_payout: 'Payout (incl. stake)', bd_profit: 'Net profit',
    bd_txhash: 'Tx hash', bd_height: 'Height',
    bd_win_note: 'Wins are not charged: the stake stays in your in-contract balance and the profit is paid from the house bankroll.',
    bd_note: '⚠️ The wallet app usually shows only the "Treasury" line above — it is the only cw20 transfer produced by this round and is NOT your bet amount. Bets and the house bankroll are internal accounting, and burning uses cw20 burn, so neither emits a transfer event. Trust the on-chain events / block explorer over the wallet summary.',
    bet_title: '💵 Bet', bet_min: 'Min', bet_max: 'Max', bet_x2: '×2', bet_half: '½',
    btn_play: 'Play', btn_submitting: 'Submitting…',
    limit_single: 'Bet Range', limit_daily: 'Daily Limit',
    // —— 2026-09-29 P1-5/6/7：history · bet panel · auto-bet ——
    hist_title: '📜 Recent Rounds', hist_empty: 'No records yet', hist_win: 'Win', hist_lose: 'Lose',
    hist_bet: 'Bet', hist_payout: 'Payout', hist_result: 'Result', hist_time: 'Time',
    stat_today: 'Today P/L', stat_streak: 'Streak', stat_total_bet: 'Total Bet', stat_roi: 'ROI',
    bet_slider: 'Slide', bet_pct: 'Pct', bet_est: 'Max est. payout', bet_daily_left: 'Daily left',
    chip_10: '10', chip_50: '50', chip_100: '100', chip_500: '500',
    auto_title: '🔁 Auto Bet', auto_n: 'Rounds', auto_start: 'Start', auto_stop: 'Stop',
    auto_progress: 'Progress', auto_done: 'Auto-bet finished', auto_stopped: 'Stopped',
    claim_title: '🎁 Claim Reward',
    claim_desc: 'Winnings are credited to your <b>in-contract balance</b>, not your wallet. Tap below to withdraw everything back to your wallet.',
    claim_btn: 'Claim All',
    claim_empty: 'No in-contract balance to claim',
    claim_loading: 'Checking…',
    claim_ok: 'Claimed',
    // —— toasts ——
    toast_open_in_paxihub: 'Please open inside the PaxiHub wallet',
    toast_connected: 'Wallet connected',
    toast_connect_fail: 'Connection failed: ',
    toast_set_contract_first: 'Set the contract address in "My Account" first',
    toast_input_amount: 'Enter a bet amount',
    toast_invalid_amount: 'Invalid amount', toast_input_amount_dep: 'Enter an amount',
    toast_added: 'Added', toast_removed: 'Removed',
    tkcc_missing: 'TKCC contract not configured — set it in "My Account" first',
    connect_wallet_first: 'Please connect your wallet first',
    register_session_busy: 'Registering session…',
    sess_registered_ok: 'Session registered', sess_register_ok2: 'Registered',
    wallet_insufficient: 'Insufficient wallet balance',
    game_insufficient: 'Insufficient in-contract balance',
    load_game_busy: 'Loading game…',
    register_first_hint: 'Register a session key to start playing (one-time; bets then skip wallet popups).',
    ready_log: (name, engine) => `${name} ready, engine ${engine}`,
    load_fail_log: 'Load failed: ',
    fail_log: 'Failed: ',
    chain_ok_log: 'On chain, height',
    you_win: '🎉 Won', you_lose: '😢 Lost',
    won_log: (v) => `🎉 Won! Payout ${v} TKCC`,
    lose_log: (v) => `Lost ${v} TKCC`,
    bet_log: (a, n) => `Bet ${a} TKCC (nonce=${n})`,
    below_min_bet: (v) => `Below minimum bet ${v} TKCC`,
    above_max_bet: (v) => `Above maximum bet ${v} TKCC`,
    engine_mismatch: (want, got) => `Engine mismatch: page expects "${want}", contract bound "${got}"`,
    game_not_configured: (id) => `Engine for game "${id}" not configured in contract`,
    limit_not_configured: (id) => `Limit for game "${id}" not configured in contract`,
    game_disabled: (id) => `Game "${id}" is disabled`,
  },
};
function hubLang() {
  return (window.HUB_LANG === 'en') ? 'en' : 'zh';
}
function hubT(k) {
  const l = hubLang();
  return (HUB_I18N[l] && HUB_I18N[l][k] != null) ? HUB_I18N[l][k]
    : (HUB_I18N.zh[k] != null ? HUB_I18N.zh[k] : k);
}
function applyHubLang() {
  const l = (window.HUB_LANG === 'en') ? 'en' : 'zh';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (HUB_I18N[l] && HUB_I18N[l][k] != null) el.textContent = HUB_I18N[l][k];
  });
  // 需要翻译 title 属性的元素（如设置按钮）
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const k = el.getAttribute('data-i18n-title');
    if (HUB_I18N[l] && HUB_I18N[l][k] != null) el.title = HUB_I18N[l][k];
  });
  // 双语内容块（玩法说明、启动错误提示等）：按语言切换显示，仅目标语言加 .active
  document.querySelectorAll('.lang-zh, .lang-en').forEach((el) => {
    el.classList.toggle('active', el.classList.contains('lang-' + l));
  });
  // 设置菜单语言高亮
  const zh = $('langZhBtn'), en = $('langEnBtn');
  if (zh) zh.innerHTML = (l === 'zh' ? '<span class="check">✓</span>' : '') + '🇨🇳 中文';
  if (en) en.innerHTML = (l === 'en' ? '<span class="check">✓</span>' : '') + '🇺🇸 English';
}

// 设置菜单开合
function toggleSettingsMenu() {
  const m = $('settingsMenu');
  if (m) m.classList.toggle('open');
}
// 点击空白处关闭菜单
document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.settings-wrap');
  const menu = $('settingsMenu');
  if (wrap && menu && !wrap.contains(e.target)) menu.classList.remove('open');
});

// 中英文切换：写全局 + 持久化 + 广播 + 重渲染
function switchLang(lang) {
  window.HUB_LANG = (lang === 'en') ? 'en' : 'zh';
  try { localStorage.setItem('paxi_hub_lang', window.HUB_LANG); } catch (e) {}
  applyHubLang();
  window.dispatchEvent(new Event('hub-lang-change'));
  // 若三国已打开，由 sanguo.js 自身监听重渲染；否则重渲染当前 tab
  if (!document.getElementById('sgBody')) switchTab(currentTab);
}

// 个性化发币 / 燃烧代币（参照原三国设置外链）
function openPump() { window.open('https://moxiaomo856.github.io/paxi-pump/', '_blank'); }
function openBurn() { window.open('https://moxiaomo856.github.io/paxi-burn/', '_blank'); }

// 玩法及经济说明（设置菜单入口）：纯静态说明，不发起任何链上请求
function openEconomyInfo() {
  const m = $('economyModal');
  if (m) m.classList.add('active');
}
function closeEconomyInfo() {
  const m = $('economyModal');
  if (m) m.classList.remove('active');
}
// 点击浮层空白处关闭
document.addEventListener('click', (e) => {
  const m = $('economyModal');
  if (m && m.classList.contains('active') && e.target === m) m.classList.remove('active');
});

// ============================================================
// 钱包
// ============================================================
async function connectWallet(silent) {
  if (typeof window.paxihub === 'undefined') {
    if (!silent) {
      showToast(hubT('toast_open_in_paxihub'), 'error');
      // DApp 指南要求的深链回退：移动端先尝试唤起 PaxiHub，1s 后跳商店/文档
      if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) {
        window.location.href = `paxi://hub/explorer?url=${encodeURIComponent(window.location.href)}`;
        setTimeout(() => {
          window.location.href = 'https://paxinet.io/paxi_docs/paxihub#paxihub-application';   // 官方 DApp 指南指定深链回退地址
        }, 1000);
      }
    }
    return false;
  }
  try {
    const sender = await window.paxihub.paxi.getAddress();
    state.wallet = sender;
    state.connected = true;
    await fetchChainId();
    updateHeader();
    await refreshBalances();
    if (!silent) showToast(hubT('toast_connected'), 'success');
    return true;
  } catch (e) {
    if (!silent) showToast(hubT('toast_connect_fail') + e.message, 'error');
    return false;
  }
}

function updateHeader() {
  const addrEl = $('hdrAddr');
  const balEl = $('hdrBal');
  const btn = $('btnConnect');
  if (state.connected && state.wallet) {
    addrEl.textContent = shortAddr(state.wallet.address, 4);
    addrEl.style.display = 'inline-block';
    balEl.style.display = 'inline-block';
    btn.style.display = 'none';
  } else {
    addrEl.style.display = 'none';
    balEl.style.display = 'none';
    btn.style.display = 'inline-flex';
  }
}

// 🟢 2026-09-29 P0-4：三路余额并发查询（Promise.all），减少串行等待；
//    任一失败不阻塞其余，缺省回落 0。
async function refreshBalances() {
  if (!state.connected) return;
  try {
    const [b, g, t] = await Promise.all([
      fetchAPI(`/cosmos/bank/v1beta1/balances/${state.wallet.address}`).catch(() => null),
      queryContract({ balance: { address: state.wallet.address, token: null } }).catch(() => null),
      CONTRACTS.tkcc
        ? queryContract({ balance: { address: state.wallet.address, token: CONTRACTS.tkcc } }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const paxi = (b && b.balances || []).find((x) => x.denom === NETWORK.denom);
    state.chainBalance = fromRawUnits(paxi ? paxi.amount : '0');
    state.gameBalance = fromRawUnits(g ? (g.amount || '0') : '0');
    state.tkccBalance = fromRawUnits(t ? (t.amount || '0') : '0');

    $('hdrBal').textContent = state.chainBalance + ' P';
    // 刷新页面上的显示
    if ($('bChain')) $('bChain').textContent = state.chainBalance;
    if ($('bGame')) $('bGame').textContent = state.gameBalance;
    if ($('bTkcc')) $('bTkcc').textContent = state.tkccBalance;
  } catch (e) {
    console.warn('refreshBalances', e);
  }
}

// ============================================================
// Tab 路由
// ============================================================
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  ctx = null;
  window.scrollTo(0, 0);

  const titles = { home: hubT('title_home'), wallet: hubT('title_wallet'), me: hubT('title_me') };
  $('pageTitle').textContent = titles[tab] || hubT('title_home');

  if (tab === 'home') {
    // 🟢 2026-10-12：「游戏」tab——直回三国页（openSanguo 异常时才兜底渲染大厅）
    if (typeof window.openSanguo === 'function') {
      try { window.openSanguo(); return; } catch (e) { console.warn('openSanguo 失败', e); }
    }
    renderHome();
  }
  else if (tab === 'wallet') renderWallet();
  else renderMe();
}

// ============================================================
// 大厅展示名单与顺序
//   🟢 合规版（2026-10-10）：只保留「三国·卡牌」。
//   猜数字 / 轮盘 / 骰宝 / 卡牌 / 疯狂骰子（TKCC 押注博弈）与
//   抽奖双币 / 抽奖单币（外部链接）已全部从前端下线。
//   定义仍在 games.js 备份（sanguoxin0929xin/），需要时可恢复。
// ============================================================
const HUB_VISIBLE_GAMES = [
  'sanguo',
  // 'choujiang', 'choujiang_dan', 'dice', 'guess', 'guess_elite', 'crazydice',  // 🟢 合规版已下线
  // 'roulette', 'roulette_vip',   // 轮盘（2026-09-29 隐藏）
];

// ============================================================
// 外部跳转类「游戏」入口
//   🟢 合规版（2026-10-10）：抽奖双币 / 抽奖单币已下线（抽奖属随机
//   博弈类玩法，与合规红线冲突），此表清空保留结构备扩展。
// ============================================================
const HUB_LINK_GAMES = {};

function hubVisibleGames() {
  const list = Array.isArray(window.GAMES) ? window.GAMES : [];
  return HUB_VISIBLE_GAMES
    .map((id) => HUB_LINK_GAMES[id] || list.find((g) => g && g.meta && g.meta.id === id))
    .filter(Boolean);
}

/** 卡片点击：外部链接 → 新窗口打开；三国 → 打开三国；其余 → 链上游戏 */
function hubOpenEntry(g, gameId) {
  if (!g) return;
  if (g.meta && g.meta.type === 'link' && g.href) {
    window.open(g.href, '_blank', 'noopener');
    return;
  }
  if (g.meta && g.meta.type === 'sanguo') { openSanguo(); return; }
  openGame(gameId);
}

// ============================================================
// 大厅
// ============================================================
async function renderHome() {
  const main = $('main');  // 合约地址还没配 —— 仍然显示卡片（禁用），顶部加 banner 引导
  if (!hasGameContract()) {
    // 外部跳转类（如抽奖）不依赖合约 → 保持可点，其余置灰
    const disabledCards = hubVisibleGames().map((g) => {
      const isLink = g.meta && g.meta.type === 'link' && g.href;
      const nm = typeof g.meta.name === 'object' ? g.meta.name[hubLang()] : g.meta.name;
      const ds = typeof g.meta.desc === 'object' ? g.meta.desc[hubLang()] : g.meta.desc;
      return `
      <div class="game-card${isLink ? '' : ' disabled'}" data-game="${g.meta.id}"${isLink ? '' : ` title="${hubT('not_deployed')}"`}>
        <div class="game-icon">${g.meta.icon || '🎮'}</div>
        <div class="game-name">${nm}</div>
        <div class="game-desc">${ds}${isLink ? ` · ${hubT('tag_external')}` : ` · ${hubT('pending_deploy')}`}</div>
      </div>`;
    }).join('');
    main.innerHTML = `
      <div class="card" style="background:#2a1a0a;border-color:#8a6a2a;margin-bottom:12px">
        <div class="card-title" style="color:#fbbf24">${hubT('banner_title')}</div>
        <div class="desc" style="color:#d4b896">
          ${hubT('banner_desc')}
          <code>index.html?contract=paxi1…</code>
        </div>
        <div class="desc" style="margin-top:6px;color:#d4b896">${hubT('banner_tip')}</div>
        <button class="btn btn-primary" style="margin-top:10px" onclick="switchTab('me')">${hubT('banner_btn')}</button>
      </div>
      <div class="card-title">${hubT('all_games')}</div>
      <div class="game-grid">${disabledCards}</div>
    `;
    // 未配置合约时，只允许外部跳转卡片可点
    document.querySelectorAll('[data-game]').forEach((el) => {
      const id = el.dataset.game;
      const g = HUB_LINK_GAMES[id] || window.GAME_REGISTRY[id];
      if (g && g.meta && g.meta.type === 'link') el.onclick = () => hubOpenEntry(g, id);
    });
    return;
  }


  // 会话状态
  let sess = null;
  try {
    sess = await Session.syncFromChain();
  } catch (e) {}
  const needRegister = !state.sessAddr || !sess || !sess.registered || !sess.pubMatches || sess.expired;

  let sessHtml = '';
  if (!state.connected) {
    sessHtml = `<div class="hint">${hubT('hint_connect')}</div>`;
  } else if (needRegister) {
    sessHtml = `<div class="hint">${hubT('hint_register')}</div>`;
  }

  const cards = hubVisibleGames().map((g) => {
    const isLink = g.meta && g.meta.type === 'link' && g.href;   // 外部跳转：不看链上状态
    const entry = state.games.find((x) => x.game_id === g.meta.id);
    const off = !isLink && entry && entry.enabled === false;
    const isSanguo = g.meta.type === 'sanguo';
    const gname = typeof g.meta.name === 'object' ? g.meta.name[hubLang()] : g.meta.name;
    const gdesc = typeof g.meta.desc === 'object' ? g.meta.desc[hubLang()] : g.meta.desc;
    // 审计 #8：通用游戏用 TKCC 下注，限额单位改为 TKCC
    const tag = isLink ? hubT('tag_external')
      : off ? hubT('disabled')
      : isSanguo ? gdesc
      : (entry ? `${fromRawUnits(entry.min_bet)} ~ ${fromRawUnits(entry.max_bet)} TKCC` : '');
    return `
      <div class="game-card${off ? ' disabled' : ''}" data-game="${g.meta.id}">
        <div class="game-icon">${g.meta.icon}</div>
        <div class="game-name">${gname}</div>
        <div class="game-desc">${gdesc}</div>
        <div class="game-tag">${tag}</div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <div class="balance-bar">
      <div class="bal-item"><div class="bal-val" id="bChain">${state.chainBalance}</div><div class="bal-lab">${hubT('bal_onchain_paxi')}</div></div>
      <div class="bal-item"><div class="bal-val" id="bGame">${state.gameBalance}</div><div class="bal-lab">${hubT('bal_incontract_paxi')}</div></div>
    </div>
    ${sessHtml}
    <div class="card">
      <div class="card-title">${hubT('choice_title')}</div>
      <div class="game-grid">${cards}</div>
    </div>`;

  document.querySelectorAll('[data-game]').forEach((el) => {
    const id = el.dataset.game;
    const g = HUB_LINK_GAMES[id] || window.GAME_REGISTRY[id];
    el.onclick = () => hubOpenEntry(g, id);
  });
}

// ============================================================
// 钱包页（充值 / 提款 / 会话）
// ============================================================
function renderWallet() {
  const main = $('main');
  const sess = state.sessInfo;
  const expired = sess && Number(sess.expires_at) < Math.floor(Date.now() / 1000);
  const sessOk = sess && !expired;

  // 🟢 合规版钱包：只有 PAXI。买卡/买碎片用钱包 PAXI 直接支付，没有 TKCC 充值/提现/下注内部余额。
  main.innerHTML = `
    <div class="card">
      <div class="card-title">${hubT('wallet_compliance_title')}</div>
      <div class="kv"><span class="k">PAXI ${hubT('wallet_bal')}</span><span class="v" id="wBal">${state.walletBal} PAXI</span></div>
      <div class="desc" style="margin-top:8px">${hubT('wallet_compliance_note')}</div>
    </div>

    <div class="card">
      <div class="card-title">${hubT('topup_title')}</div>
      <div class="kv"><span class="k">${hubT('sess_addr')}</span><span class="v">${shortAddr(state.sessAddr, 8) || '—'}</span></div>
      <div class="kv"><span class="k">${hubT('topup_sess_bal')}</span><span class="v" id="sessBal">${hubT('loading')}</span></div>
      <div class="field">
        <label class="label">${hubT('amt_label')} (PAXI)</label>
        <input type="text" id="topupAmt" inputmode="decimal" placeholder="0.0" />
        <div class="quick-row">
          <button class="quick" data-topup="2">2</button>
          <button class="quick" data-topup="5">5</button>
          <button class="quick" data-topup="10">10</button>
          <button class="quick" data-topup="20">20</button>
        </div>
      </div>
      <button class="btn btn-primary" id="btnTopup">${hubT('topup_btn')}</button>
      <div class="desc" style="margin-top:8px">${hubT('topup_desc')}</div>
    </div>

    <div class="card">
      <div class="card-title">${hubT('sess_title')}</div>
      <div class="kv"><span class="k">${hubT('sess_status')}</span><span class="v">${
        !sess ? hubT('sess_unregistered') : expired ? `<span class="warn-txt">${hubT('sess_expired')}</span>` : `<span class="ok-txt">${hubT('sess_ok')}</span>`
      }</span></div>
      <div class="kv"><span class="k">${hubT('sess_addr')}</span><span class="v">${shortAddr(state.sessAddr, 8) || '—'}</span></div>
      <div class="kv"><span class="k">nonce</span><span class="v">${state.sessNonce}</span></div>
      ${sessOk ? `<div class="kv"><span class="k">${hubT('sess_daily_quota')}</span><span class="v">${fromRawUnits(sess.daily_used)} / ${fromRawUnits(sess.daily_limit)}</span></div>` : ''}
      <button class="btn ${sessOk ? 'btn-ghost' : 'btn-primary'}" id="btnSess" style="margin-top:10px">
        ${sessOk ? hubT('sess_renew') : hubT('sess_register')}
      </button>
      <div class="desc" style="margin-top:8px">${hubT('sess_desc')}</div>
    </div>

    <div class="card"><div class="card-title">${hubT('log_title')}</div><div class="log" id="log"></div></div>`;

  $('btnSess').onclick = doRegisterSession;

  document.querySelectorAll('[data-topup]').forEach((b) => {
    b.onclick = () => { $('topupAmt').value = b.dataset.topup; };
  });
  $('btnTopup').onclick = doTopUpSession;

  // 拉 PAXI 钱包余额（不阻塞渲染）
  refreshWalletPaxi();
  refreshSessionBal();
}

/** 合规版：给会话地址充值 PAXI（买卡/买碎片的资金来源，弹 1 次主钱包） */
async function doTopUpSession() {
  const v = parseFloat($('topupAmt').value) || 0;
  if (!(v > 0)) { showToast(hubT('topup_bad_amt'), 'error'); return; }
  if (!window.Session || typeof Session.topUpSession !== 'function' || !state.sessAddr) {
    showToast(hubT('topup_no_session'), 'error');
    return;
  }
  try {
    showToast(hubT('processing'));
    await Session.topUpSession(toRawUnits(String(v)));
    showToast(hubT('topup_done'), 'success');
    refreshSessionBal();
    refreshWalletPaxi();
  } catch (e) {
    showToast(e.message || String(e), 'error');
  }
}

/** 刷新会话地址 PAXI 余额显示 */
async function refreshSessionBal() {
  const el = $('sessBal');
  if (!el) return;
  if (!window.Session || typeof Session.getSessionBalance !== 'function' || !state.sessAddr) {
    el.textContent = '—';
    return;
  }
  try {
    const raw = await Session.getSessionBalance();
    el.textContent = `${fromRawUnits(raw)} PAXI`;
  } catch (e) {
    el.textContent = '—';
  }
}

/** 合规版：只拉 PAXI 钱包余额（不显示 TKCC 下注内部余额） */
async function refreshWalletPaxi() {
  if (!state.connected || !hasGameContract()) return;
  try {
    const w = await queryWalletBalance(NATIVE_TOKEN).catch(() => '0');
    state.walletBal = w;
    const wb = $('wBal');
    if (wb) wb.textContent = `${w} PAXI`;
  } catch (e) {
    console.warn('刷新 PAXI 余额失败', e.message);
  }
}

/** 切换代币：更新选中项，重渲染卡片 */
function switchToken(key) {
  state.selToken = key;
  renderWallet();
}

/** 刷新当前选中代币的两种余额 */
async function refreshTokenBalances() {
  if (!state.connected || !hasGameContract()) return;
  const t = findToken(state.tokens.length ? state.tokens : [NATIVE_TOKEN], state.selToken);
  try {
    const [w, g] = await Promise.all([
      queryWalletBalance(t).catch(() => '0'),
      queryGameBalance(t).catch(() => '0'),
    ]);
    state.walletBal = w;
    state.gameBal = g;
    const wb = $('wBal'), gb = $('gBal2');
    if (wb) wb.textContent = `${w} ${esc(t.symbol)}`;
    if (gb) gb.textContent = `${g} ${esc(t.symbol)}`;
  } catch (e) {
    console.warn('刷新代币余额失败', e.message);
  }
}

/** 添加 PRC-20 代币 */
function showAddToken() {
  const main = $('main');
  const isEn = hubLang() === 'en';
  main.innerHTML = `
    <div class="back-bar" onclick="switchTab('wallet')">${hubT('back_wallet')}</div>
    <div class="card">
      <div class="card-title">${hubT('add_token')}</div>
      <div class="field">
        <label class="label">${hubT('contract_addr_label')}</label>
        <input type="text" class="input" id="inTokenAddr" placeholder="paxi1…" spellcheck="false" autocapitalize="off" autocorrect="off">
      </div>
      <button class="btn btn-primary" onclick="doAddToken()">${isEn ? 'Add' : '添加'}</button>
      <div class="desc" style="margin-top:10px">
        ${isEn
          ? 'Before adding, make sure the token is <b>whitelisted in the game contract</b> (admin calls <code>AddPrc20</code>), otherwise deposits will be rejected. Whitelisted tokens appear automatically; only add ones not listed.'
          : '添加前请确认该代币<b>已加入游戏合约白名单</b>（管理员调 <code>AddPrc20</code>），否则充值会被拒绝。合约白名单里的代币会自动出现，这里只需要添加没自动列出来的。'}
      </div>
      ${extraTokens().length ? `
        <div class="card-title" style="margin-top:16px">${isEn ? 'Manually Added' : '已手动添加'}</div>
        ${extraTokens().map((a) => `
          <div class="kv">
            <span class="k"><code>${shortAddr(a, 8)}</code></span>
            <span class="v"><button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="doRemoveToken('${a}')">${isEn ? 'Remove' : '移除'}</button></span>
          </div>`).join('')}
      ` : ''}
    </div>`;
}

async function doAddToken() {
  const addr = ($('inTokenAddr')?.value || '').trim();
  try {
    addExtraToken(addr);
    showToast(hubT('toast_added'));
    await loadTokens();
    state.selToken = 'cw20:' + addr;
    switchTab('wallet');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function doRemoveToken(addr) {
  removeExtraToken(addr);
  showToast(hubT('toast_removed'));
  loadTokens().then(() => showAddToken());
}

/** 启动时拉一次代币列表 */
async function loadTokens() {
  try {
    state.tokens = await loadTokenList();
  } catch (e) {
    state.tokens = [NATIVE_TOKEN];
  }
  // 🔴 默认选 TKCC（游戏主用 TKCC），找不到才回退 PAXI
  const tk = state.tokens.find((t) => t.symbol === 'TKCC');
  state.selToken = tk ? tk.key : NATIVE_TOKEN.key;
  return state.tokens;
}

async function doDeposit() {
  const t = findToken(state.tokens.length ? state.tokens : [NATIVE_TOKEN], state.selToken);
  const amt = ($('depAmt')?.value || '').trim();
  if (!amt || Number(amt) <= 0) return showToast(hubT('toast_input_amount_dep'), 'error');

  const raw = toRawUnits(amt, t.decimals);
  if (BigInt(raw) <= 0n) return showToast(hubT('toast_invalid_amount'), 'error');

  // 链上余额够不够
  const walletRaw = toRawUnits(state.walletBal, t.decimals);
  if (BigInt(raw) > BigInt(walletRaw)) {
    return showToast(`${hubT('wallet_insufficient')}（${state.walletBal} ${esc(t.symbol)}）`, 'error');
  }

  showBusy(hubT('dep_btn') + '…');
  try {
    let hash;
    if (t.type === 'native') {
      // 原生 PAXI：附带 funds 一步到位
      hash = await execContract(
        { deposit: { token: null, amount: raw } },
        [{ denom: NETWORK.denom, amount: raw }],
      );
      await waitForTx(hash);
    } else {
      // PRC-20：合约用 transfer_from 主动拉取，必须先有 allowance
      const allowance = await queryPrc20Allowance(t.contract, state.wallet.address, CONTRACTS.game);
      if (BigInt(allowance) < BigInt(raw)) {
        log('授权额度不足，先发授权交易…', 'info');
        const h1 = await approvePrc20(t.contract, raw);
        await waitForTx(h1);
        log('授权完成，开始充值…', 'ok');
      }
      hash = await execContract({ deposit: { token: t.contract, amount: raw } });
      await waitForTx(hash);
    }
    log(`充值成功 ${amt} ${esc(t.symbol)}`, 'ok');
    showToast('充值成功', 'success');
    $('depAmt').value = '';
    await refreshBalances();
    await refreshTokenBalances();
  } catch (e) {
    const msg = e.message || String(e);
    log('充值失败：' + msg, 'err');
    showToast(msg, 'error');
  } finally {
    hideBusy();
  }
}

async function doWithdraw() {
  const t = findToken(state.tokens.length ? state.tokens : [NATIVE_TOKEN], state.selToken);
  const amt = ($('wdAmt')?.value || '').trim();
  if (!amt || Number(amt) <= 0) return showToast(hubT('toast_input_amount_dep'), 'error');

  const raw = toRawUnits(amt, t.decimals);
  if (BigInt(raw) <= 0n) return showToast(hubT('toast_invalid_amount'), 'error');

  const gameRaw = toRawUnits(state.gameBal, t.decimals);
  if (BigInt(raw) > BigInt(gameRaw)) {
    return showToast(`${hubT('game_insufficient')}（${state.gameBal} ${esc(t.symbol)}）`, 'error');
  }

  showBusy(hubT('wd_btn') + '…');
  try {
    const hash = await execContract({
      withdraw: { token: t.type === 'native' ? null : t.contract, amount: raw },
    });
    await waitForTx(hash);
    log(`提款成功 ${amt} ${esc(t.symbol)}`, 'ok');
    showToast('提款成功', 'success');
    $('wdAmt').value = '';
    await refreshBalances();
    await refreshTokenBalances();
  } catch (e) {
    const msg = e.message || String(e);
    log('提款失败：' + msg, 'err');
    showToast(msg, 'error');
  } finally {
    hideBusy();
  }
}

async function doRegisterSession() {
  showBusy(hubT('register_session_busy'));
  try {
    if (!state.connected) throw new Error(hubT('connect_wallet_first'));
    await Session.register();
    showToast(hubT('sess_registered_ok'), 'success');
    log('会话注册成功，nonce=' + state.sessNonce, 'ok');
    renderWallet();
  } catch (e) {
    log('注册失败：' + e.message, 'err');
    showToast(e.message, 'error');
  } finally {
    hideBusy();
  }
}

// ============================================================
// 我的
// ============================================================
function renderMe() {
  const main = $('main');
  const sess = state.sessInfo;
  main.innerHTML = `
    <div class="card">
      <div class="card-title">${hubT('acc_title')}</div>
      <div class="kv"><span class="k">${hubT('acc_wallet_addr')}</span><span class="v">${shortAddr(state.wallet?.address, 8) || '—'}</span></div>
      <div class="kv"><span class="k">${hubT('acc_sess_addr')}</span><span class="v">${shortAddr(state.sessAddr, 8) || '—'}</span></div>
      <div class="kv"><span class="k">${hubT('acc_chain_id')}</span><span class="v">${state.chainId || '—'}</span></div>
      <div class="desc" style="margin-top:6px;opacity:.6">build ${window.HUB_BUILD || hubT('acc_build_unknown')}</div>
    </div>

    <div class="card">
      <div class="card-title">${hubT('seamless_title')}</div>
      <div class="kv"><span class="k">${hubT('seamless_status')}</span><span class="v" id="seamlessStatus">${hubT('seamless_checking')}</span></div>
      <div class="kv"><span class="k">${hubT('seamless_feegrant')}</span><span class="v" id="seamlessFeegrant">${hubT('seamless_checking')}</span></div>
      <div class="kv"><span class="k">${hubT('seamless_bal')}</span><span class="v" id="seamlessBal">${hubT('seamless_checking')}</span></div>
      <div class="kv"><span class="k">${hubT('seamless_expiry')}</span><span class="v" id="seamlessExpiry">—</span></div>
      <button class="btn btn-primary" id="btnSeamless" style="margin-top:10px">${hubT('seamless_enable_btn')}</button>
      <button class="btn btn-ghost" id="btnSelfCheck" style="margin-top:8px">${hubT('seamless_selfcheck_btn')}</button>
      <div id="selfCheckBox" style="display:none;margin-top:10px"></div>
      <div class="desc" style="margin-top:8px">${hubT('seamless_desc')}</div>
    </div>

    <div class="card">
      <div class="card-title">${hubT('contract_title')}</div>
      <div class="kv"><span class="k">${hubT('acc_game_contract')}</span><span class="v">${
        CONTRACTS.game ? shortAddr(CONTRACTS.game, 8) : `<span style="color:#c0392b">${hubT('not_configured')}</span>`
      }</span></div>
      <div class="kv"><span class="k">${hubT('contract_tkcc_label')}</span><span class="v" style="color:#6ee7b7">${CONTRACTS.tkcc ? shortAddr(CONTRACTS.tkcc, 8) : '—'}</span></div>

      <div class="field">
        <label class="label">${hubT('contract_game_label')}</label>
        <input type="text" class="input" id="inContract" placeholder="${hubLang() === 'en' ? 'paxi1… (address returned after instantiate)' : 'paxi1…（instantiate 后拿到的地址）'}" value="${CONTRACTS.game || ''}" spellcheck="false" autocapitalize="off" autocorrect="off">
      </div>
      <button class="btn btn-primary" onclick="saveContracts()">${hubT('save_btn')}</button>
      <div class="desc" style="margin-top:8px">
        ${hubT('contract_desc')}
        <code>index.html?contract=paxi1…</code>
      </div>
      <button class="btn btn-ghost" style="margin-top:8px" onclick="clearContracts()">${hubT('clear_contracts_btn')}</button>
    </div>

    <div class="card">
      <div class="card-title">${hubT('limit_title')}</div>
      <div class="desc" style="margin:2px 0 6px">${hubT('limit_compliance')}</div>
    </div>

    <div class="card">
      <button class="btn btn-ghost" onclick="hardReset()">${hubT('reset_session')}</button>
      <div class="desc" style="margin-top:8px">
        ${hubT('reset_session_desc')}
      </div>
    </div>`;

  renderSeamlessCard();
}

async function renderSeamlessCard() {
  const btn = $('btnSeamless');
  if (!btn) return;

  // 🟢 第十八轮：状态一律以链上为准（会话注册 + Feegrant 授权 + 会话余额）
  const v = await Session.verifySeamless(true).catch((e) => ({ ok: false, mode: 'none', reason: (e && e.message) || hubT('seamless_check_failed') }));
  const info = await Session.syncFromChain().catch(() => null);
  const fg = await Session.getFeegrant(true).catch(() => null);
  const nowSec = Math.floor(Date.now() / 1000);
  const hoursLeft = (info && info.expiresAt) ? Math.max(0, (info.expiresAt - nowSec) / 3600) : 0;
  const sessionOk = !!(info && info.registered && !info.expired && info.pubMatches);

  // 会话状态
  if (!sessionOk) {
    $('seamlessStatus').innerHTML = `<span class="warn-txt">${hubT('seamless_st_off')}</span>`;
    $('seamlessExpiry').textContent = '—';
  } else if (hoursLeft < 2) {
    $('seamlessStatus').innerHTML = `<span class="warn-txt">${hubT('seamless_st_expiring')}</span>`;
    $('seamlessExpiry').textContent = hubT('seamless_hours')(hoursLeft.toFixed(1));
  } else {
    $('seamlessStatus').innerHTML = v.ok
      ? `<span class="ok-txt">${hubT('seamless_st_ok')}</span>`
      : `<span class="warn-txt">${hubT('seamless_st_nogas')}</span>`;
    $('seamlessExpiry').textContent = hubT('seamless_hours')(hoursLeft.toFixed(1));
  }

  // gas 代付授权（链上真实查询）
  if (fg && fg.ok) {
    // 🟢 5A：Feegrant 剩余时间 < 24h 时高亮提醒
    const fgHours = fg.expiration ? (fg.expiration - Date.now()) / 3600000 : 0;
    const warnSuffix = (fgHours > 0 && fgHours < 24)
      ? ` <span class="warn-txt">（${fgHours.toFixed(1)}h 后过期）</span>`
      : '';
    $('seamlessFeegrant').innerHTML =
      `<span class="ok-txt">${hubT('seamless_fg_valid')}</span>${hubT('seamless_fg_detail')(Session.fmtPaxi(fg.spendLimit))}${warnSuffix}`;
  } else if (fg && fg.unknown) {
    $('seamlessFeegrant').innerHTML = `<span class="warn-txt">${hubT('seamless_fg_queryfail')}</span>`;
  } else {
    $('seamlessFeegrant').innerHTML = `<span class="warn-txt">${hubT('seamless_fg_none')}</span>`;
  }

  // 会话账户余额（Feegrant 不可用时的兜底付费方）
  let bal = '0';
  try { bal = await Session.getSessionBalance(); } catch (e) {}
  const plan = await computeSeamlessFee().catch(() => null);
  const balEl = $('seamlessBal');
  if (plan) {
    balEl.textContent = hubT('seamless_bal_detail')(Session.fmtPaxi(bal), Session.fmtPaxi(plan.amount));
    // 🟢 6A：Feegrant 不可用 + 会话余额 < 10 笔手续费时高亮
    if (fg && !fg.ok) {
      try {
        const threshold = BigInt(plan.amount) * 10n;
        if (BigInt(bal) < threshold) {
          balEl.innerHTML += ` <span class="warn-txt">（余额偏低，建议充值）</span>`;
        }
      } catch (e) {}
    }
  } else {
    balEl.textContent = hubT('seamless_bal_plain')(Session.fmtPaxi(bal));
  }

  btn.textContent = sessionOk ? hubT('seamless_renew_btn') : hubT('seamless_enable_btn');

  btn.onclick = async () => {
    showBusy(hubT('seamless_busy'));
    try {
      await Session.enableSeamlessMode();
      showToast(hubT('seamless_ok_toast'), 'success');
      await renderSeamlessCard();
    } catch (e) {
      showToast((e && e.message) || hubT('seamless_fail_toast'), 'error');
    } finally { hideBusy(); }
  };

  const sc = $('btnSelfCheck');
  if (sc) sc.onclick = async () => {
    const box = $('selfCheckBox');
    box.style.display = 'block';
    box.innerHTML = `<div class="desc">${hubT('seamless_checking')}</div>`;
    try {
      const r = await Session.selfCheck();
      const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
      box.innerHTML = `<div class="desc" style="margin-bottom:6px">build ${r.build}</div>`
        + r.items.map((it) => `<div class="kv" style="align-items:flex-start">
             <span class="k" style="flex:0 0 42%">${icon[it.ok]} ${it.name}</span>
             <span class="v" style="word-break:break-all;text-align:right">${it.detail || '—'}</span>
           </div>`).join('');
      console.log('[无感自检]', r);
    } catch (e) {
      box.innerHTML = `<div class="desc" style="color:#c0392b">${hubT('seamless_checkfail')((e && e.message) || e)}</div>`;
    }
  };
}

function saveContracts() {
  try {
    const game = ($('inContract')?.value || '').trim();
    setContract('contract', game);      // 留空 = 删除该项
    showToast(CONTRACTS.game ? '已保存，正在刷新' : '已清除地址');
    setTimeout(() => window.location.reload(), 600);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function clearContracts() {
  try {
    localStorage.removeItem('paxi_hub_contract_contract');
  } catch (e) {}
  showToast('已清除，回到代码默认值');
  setTimeout(() => window.location.reload(), 600);
}

function hardReset() {
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
  // 🟢 第十八轮：连 gas 代付标记一起清掉，否则重开后仍会误判无感已开通
  try { localStorage.removeItem('paxi_hub_feegrant_expires'); } catch (e) {}
  if (window.Session) {
    // 清掉所有内存缓存（链上查询缓存、失败标记、待重授权标记）+ 内存私钥
    window.Session._fgCache = { at: 0, granter: '', data: null };
    window.Session._seamlessFailedOnce = false;
    window.Session._forceRegrant = false;
    window.Session._lastSeamlessError = null;
    if (typeof window.Session.lock === 'function') window.Session.lock();
  }
  showToast('已清除，请重新注册会话');
  setTimeout(() => window.location.reload(), 800);
}

// ============================================================
// 游戏页
// ============================================================
async function openGame(gameId) {
  const g = window.GAME_REGISTRY[gameId];
  if (!g) return;

  if (!hasGameContract()) {
    showToast(hubT('toast_set_contract_first'), 'error');
    switchTab('me');
    return;
  }

  if (!state.connected) {
    const ok = await connectWallet(false);
    if (!ok) return;
  }

  showBusy(hubT('load_game_busy'));
  try {
    await connectWallet(true);

    // 1. 会话
    const r = await Session.ensure();
    if (!r.ok) {
      hideBusy();
      $('main').innerHTML = `
        <div class="back-bar" onclick="switchTab('home')">${hubT('back_home')}</div>
        <div class="hint">${r.reason}</div>
        <div class="card">
          <div class="desc">${hubT('register_first_hint')}</div>
          <button class="btn btn-primary" style="margin-top:12px" onclick="quickRegister()">${hubT('sess_register')}</button>
        </div>`;
      return;
    }

    // 2. 引擎配置 + 限额
    const cfg = await queryContract({ game_engine_config_query: { game_id: gameId } });
    const lim = await queryContract({ game_limit: { game_id: gameId } });
    if (!cfg.config) throw new Error(hubT('game_not_configured')(gameId));
    if (!lim.limit) throw new Error(hubT('limit_not_configured')(gameId));
    if (!lim.limit.enabled) throw new Error(hubT('game_disabled')(gameId));

    // 🟢 2026-09-29 P0-2 引擎识别兼容：优先用链上显式字段 cfg.config.engine，
    //    回退到按 params 的 key 取（旧合约没 engine 字段时不影响）。
    //    注意：g.meta.engine 是前端注册表写死的值，必须与链上一致，否则抛引擎不匹配。
    const engineKey = (cfg.config && typeof cfg.config.engine === 'string' && cfg.config.engine)
      ? cfg.config.engine
      : Object.keys(cfg.config.params || {})[0];
    if (engineKey !== g.meta.engine) {
      throw new Error(hubT('engine_mismatch')(g.meta.engine, engineKey));
    }

    // 2.5 本局链上明细用：销毁 / 运营比例（优先本游戏 GameConfig 覆盖，回落全局）
    let econ = { burnEnabled: true, burnBps: 500, treasBps: 500 };
    try {
      const [gc, bc, tc] = await Promise.all([
        queryContract({ game_config: { game_id: gameId } }).catch(() => null),
        queryContract({ burn_config: {} }).catch(() => null),
        queryContract({ treasury_config: {} }).catch(() => null),
      ]);
      const burnBps = (gc && gc.burn_rate_override != null)
        ? Number(gc.burn_rate_override)
        : (bc && bc.burn_rate != null ? Number(bc.burn_rate) : 500);
      const treasBps = (gc && gc.treasury_share_override != null)
        ? Number(gc.treasury_share_override)
        : (tc && tc.treasury_share != null ? Number(tc.treasury_share) : 500);
      econ = { burnEnabled: !gc || gc.burn_enabled !== false, burnBps, treasBps };
    } catch (e) {}

    ctx = {
      id: gameId,
      game: g,
      params: cfg.config.params[engineKey],
      limit: lim.limit,
      econ,
    };

    // 3. 渲染
    const body = g.body(ctx);
    const gname = typeof g.meta.name === 'object' ? g.meta.name[hubLang()] : g.meta.name;
    $('pageTitle').textContent = gname;
    $('main').innerHTML = `
      <div class="back-bar" onclick="switchTab('home')">${hubT('back_home')}</div>

      <div class="balance-bar">
        <div class="bal-item"><div class="bal-val" id="gBal">${state.gameBalance}</div><div class="bal-lab">${hubT('bal_incontract_paxi')}</div></div>
        <div class="bal-item"><div class="bal-val small">${fromRawUnits(lim.limit.min_bet)}~${fromRawUnits(lim.limit.max_bet)}</div><div class="bal-lab">${hubT('limit_single')}</div></div>
        <div class="bal-item"><div class="bal-val small">${fromRawUnits(lim.limit.max_daily_bet)} / ${lim.limit.max_daily_rounds}${hubLang() === 'en' ? ' rounds' : '局'}</div><div class="bal-lab">${hubT('limit_daily')}</div></div>
      </div>

      <div class="card" id="gameClaimCard" style="display:none">
        <div class="card-title">${hubT('claim_title')}</div>
        <div class="kv"><span class="k">${hubT('incontract_bal')}</span><span class="v" id="gcBal">${hubT('claim_loading')}</span></div>
        <div class="desc" style="margin-top:6px">${hubT('claim_desc')}</div>
        <button class="btn btn-gold" id="btnGameClaim" style="margin-top:8px;width:100%">${hubT('claim_btn')}</button>
      </div>

      <div class="card">
        <div class="card-title">${hubT('result_title')}</div>
        <div class="result-stage" id="stage"><span class="placeholder-txt">${hubT('result_placeholder')}</span></div>
      </div>

      <div class="card" id="bdCard" style="display:none">
        <div class="card-title">${hubT('bd_title')}</div>
        <div id="bdBody"></div>
        <div class="kv"><span class="k">${hubT('bd_txhash')}</span><span class="v" id="bdHash">—</span></div>
        <div class="kv"><span class="k">${hubT('bd_height')}</span><span class="v" id="bdHeight">—</span></div>
        <div class="desc" style="margin-top:8px" id="bdNote"></div>
      </div>

      ${body}

      <div class="card">
        <div class="card-title">${hubT('bet_title')}</div>
        <div class="field">
          <input type="text" id="betAmt" inputmode="decimal" value="${fromRawUnits(lim.limit.min_bet)}" />
          <input type="range" id="betSlider" class="bet-slider"
            min="${fromRawUnits(lim.limit.min_bet)}" max="${fromRawUnits(lim.limit.max_bet)}"
            step="1" value="${fromRawUnits(lim.limit.min_bet)}" />
          <div class="quick-row">
            <button class="quick" data-bet="${fromRawUnits(lim.limit.min_bet)}">${hubT('bet_min')}</button>
            <button class="quick" data-bet="${fromRawUnits(lim.limit.max_bet)}">${hubT('bet_max')}</button>
            <button class="quick" data-bet="x2">${hubT('bet_x2')}</button>
            <button class="quick" data-bet="half">${hubT('bet_half')}</button>
          </div>
          <div class="quick-row">
            <button class="quick chip" data-chip="10">${hubT('chip_10')}</button>
            <button class="quick chip" data-chip="50">${hubT('chip_50')}</button>
            <button class="quick chip" data-chip="100">${hubT('chip_100')}</button>
            <button class="quick chip" data-chip="500">${hubT('chip_500')}</button>
            <button class="quick" data-pct="10">10%</button>
            <button class="quick" data-pct="25">25%</button>
            <button class="quick" data-pct="50">50%</button>
            <button class="quick" data-pct="max">${hubT('all_btn')}</button>
          </div>
          <div class="bet-info">
            <span>${hubT('bet_est')}: <b id="estOut">—</b></span>
            <span>${hubT('bet_daily_left')}: <b id="dailyLeft">${
              (() => { const md = BigInt(lim.limit.max_daily_bet); const used = BigInt((state.sessInfo && state.sessInfo.daily_used) || '0'); const left = md > used ? md - used : 0n; return fromRawUnits(left.toString()); })()
            } TKCC</b></span>
          </div>
        </div>
        <button class="btn btn-gold" id="btnPlay">${hubT('btn_play')}</button>
      </div>

      <div class="card" id="autoCard">
        <div class="card-title">${hubT('auto_title')}</div>
        <div class="field" style="display:flex;align-items:center;gap:8px">
          <input type="number" id="autoN" class="input" style="width:80px" min="1" max="50" value="5" />
          <span>${hubT('auto_n')}</span>
          <button class="btn btn-ghost" id="btnAutoStart">${hubT('auto_start')}</button>
          <button class="btn btn-ghost" id="btnAutoStop" style="display:none">${hubT('auto_stop')}</button>
          <span id="autoProgress" class="auto-prog"></span>
        </div>
        <div class="desc" style="margin-top:6px">${hubT('auto_title')} · 每局重新取链上 nonce，串行执行，受余额/限额约束；随时可停止。</div>
      </div>

      <div class="card" id="histCard">
        <div class="card-title">${hubT('hist_title')}</div>
        <div id="histBody"></div>
      </div>

      <div class="card"><div class="card-title">${hubT('log_title')}</div><div class="log" id="log"></div></div>`;

    g.bind(ctx);
    const maxBet = Number(fromRawUnits(lim.limit.max_bet));
    const setBet = (val) => {
      let v = Number(val);
      if (!isFinite(v) || v < 0) v = 0;
      v = Math.min(v, maxBet);
      if ($('betAmt')) $('betAmt').value = String(v);
      if ($('betSlider')) $('betSlider').value = String(v);
      updateEstPayout();
    };
    document.querySelectorAll('[data-bet]').forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.bet;
        const cur = Number($('betAmt')?.value) || 0;
        if (v === 'x2') setBet(cur * 2);
        else if (v === 'half') setBet(cur / 2);
        else setBet(v);
      };
    });
    const slider = $('betSlider');
    if (slider) slider.oninput = () => { if ($('betAmt')) $('betAmt').value = slider.value; updateEstPayout(); };
    document.querySelectorAll('[data-chip]').forEach((b) => { b.onclick = () => setBet(b.dataset.chip); });
    document.querySelectorAll('[data-pct]').forEach((b) => {
      b.onclick = () => { const p = b.dataset.pct; setBet(p === 'max' ? maxBet : (maxBet * Number(p) / 100)); };
    });
    const betInput = $('betAmt');
    if (betInput) betInput.oninput = updateEstPayout;
    updateEstPayout();   // 🟢 2026-09-29 P1-6 初始估算

    $('btnPlay').onclick = doPlay;
    // 🟢 2026-09-29 P1-7 连续下注
    const autoStart = $('btnAutoStart'), autoStop = $('btnAutoStop');
    if (autoStart) autoStart.onclick = () => {
      autoBetStop = false;
      autoStart.style.display = 'none';
      if (autoStop) autoStop.style.display = '';
      autoBetLoop($('autoN') ? $('autoN').value : 5).then(() => {
        if (autoStart) autoStart.style.display = '';
        if (autoStop) autoStop.style.display = 'none';
      });
    };
    if (autoStop) autoStop.onclick = () => { autoBetStop = true; };

    const gcBtn = $('btnGameClaim');
    if (gcBtn) gcBtn.onclick = claimGameReward;
    refreshGameClaim();   // 异步拉合约内余额，有余额才显示「领取奖励」卡片
    renderHistory(ctx.id);   // 🟢 2026-09-29 P1-5 渲染历史
    log(hubT('ready_log')(gname, engineKey), 'ok');
  } catch (e) {
    log(hubT('load_fail_log') + e.message, 'err');
    $('main').innerHTML = `
      <div class="back-bar" onclick="switchTab('home')">${hubT('back_home')}</div>
      <div class="hint err">${esc(e.message)}</div>`;
  } finally {
    hideBusy();
  }
}

async function quickRegister() {
  showBusy(hubT('register_session_busy'));
  try {
    await Session.register();
    showToast(hubT('sess_register_ok2'), 'success');
    openGame(ctx ? ctx.id : (hubVisibleGames()[0] || window.GAMES[0]).meta.id); // 默认进第一个可见游戏（三国）
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    hideBusy();
  }
}

async function doPlay() {
  if (!ctx) return false;
  // 🟢 L3 审计修复（2026-10-10）：三国卡牌必须走 sanguoExec（会话验签消息族），
  //    通用 Play 在合规合约下会被拒绝（unknown variant / ComplianceDisabled）。
  //    这里显式拦截，避免将来误用时得到一个难以排查的报错。
  if (ctx.id === 'sanguo') throw new Error('sanguo 必须走 sanguoExec，禁止通用 Play');
  const btn = $('btnPlay');
  let amt, ok = false;
  try {
    amt = $('betAmt').value.trim();
    if (!amt || Number(amt) <= 0) throw new Error(hubT('toast_input_amount'));
    // 审计 #11：UI 全部按 TKCC 展示，未配置 TKCC 合约时直接拒绝，不再静默回退 PAXI
    if (!CONTRACTS.tkcc) throw new Error(hubT('tkcc_missing'));
    const input = ctx.getInput();
    const betU = toRawUnits(amt);

    if (BigInt(betU) < BigInt(ctx.limit.min_bet)) {
      throw new Error(hubT('below_min_bet')(fromRawUnits(ctx.limit.min_bet)));
    }
    if (BigInt(betU) > BigInt(ctx.limit.max_bet)) {
      throw new Error(hubT('above_max_bet')(fromRawUnits(ctx.limit.max_bet)));
    }

    btn.disabled = true;
    btn.textContent = hubT('btn_submitting');
    $('stage').innerHTML = '<div class="spinner"></div>';

    const roundId = `${ctx.id}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

    // nonce 永远取链上最新，避免本地漂移导致会话卡死
    await Session.syncFromChain();

    const msg = Session.buildMessage({
      gameId: ctx.id,
      action: 'play',
      roundId,
      amountPayout: betU,
      nonce: state.sessNonce,
    });
    const sig = await Session.sign(msg);
    // 🟢 与 sanguoExec 对齐：空签名守卫（noble 2.1.0 返回 Signature 对象，必须 toCompactRawBytes，
    //   否则签名为空 → 带 signature:\"\" 的必败交易被推给钱包）。拦截就地报错，绝不静默发坏交易。
    if (!sig || !/^[0-9a-f]{128}$/.test(sig)) {
      throw new Error('会话签名异常（签名为空）——通常是浏览器缓存了旧版脚本，请强制刷新页面（或清除缓存）后重试');
    }
    log(hubT('bet_log')(amt, state.sessNonce), 'info');

    const hash = await execContract({
      play: {
        game_id: ctx.id,
        round_id: roundId,
        token: CONTRACTS.tkcc,
        bet: betU,
        guess_input: null,
        roulette_input: null,
        dice_input: null,
        card_input: null,
        score_input: null,
        session_addr: state.sessAddr,
        nonce: state.sessNonce,
        signature: sig,
        ...input,
      },
    });

    const tx = await waitForTx(hash);
    Session.bumpNonce();   // 只有确认上链后才自增
    log(`${hubT('chain_ok_log')} ${tx.height}`, 'ok');

    const ev = parseTxEvents(tx, ['won', 'payout', 'profit_paid', 'result', 'engine_result', 'bet', 'burn_amount', 'treasury_amount']);
    const first = (k) => (ev[k] && ev[k].length ? ev[k][ev[k].length - 1] : undefined);
    const out = {
      won: first('won') === 'true',
      payout: first('payout'),
      engineResult: first('engine_result'),
      bet: first('bet'),
      burnAmount: first('burn_amount'),
      treasuryAmount: first('treasury_amount'),
      raw: ev,
    };

    const html = ctx.game.result ? ctx.game.result(ctx, out) : '';
    $('stage').innerHTML = html || `<div class="big-result">${out.won ? hubT('you_win') : hubT('you_lose')}</div>`;

    // 🟢 2026-09-29 P1-11：赢/输震动反馈
    if (navigator.vibrate) { try { navigator.vibrate(out.won ? [30, 50, 30] : 80); } catch (e) {} }

    renderTxBreakdown(out, hash, tx.height, betU);

    log(
      out.won
        ? hubT('won_log')(fromRawUnits(out.payout || '0'))
        : hubT('lose_log')(amt),
      out.won ? 'ok' : 'err',
    );
    if (out.engineResult) log(`${hubLang() === 'en' ? 'Result' : '结果'}: ${out.engineResult}`, 'info');

    // 🟢 2026-09-29 P1-5：记录本局到本地历史（纯前端，不发链上）
    pushHistory(ctx.id, {
      won: out.won,
      bet: amt,
      payout: fromRawUnits(out.payout || '0'),
      result: out.engineResult || (out.won ? 'win' : 'lose'),
    });
    renderHistory(ctx.id);

    await refreshBalances();
    const gb = $('gBal');
    if (gb) gb.textContent = state.gameBalance;
    ok = true;   // 🟢 2026-09-29：只有走到这里才算成功，供连续下注判断
  } catch (e) {
    log(hubT('fail_log') + e.message, 'err');
    showToast(e.message, 'error');
    $('stage').innerHTML = `<span class="placeholder-txt">${hubT('result_placeholder')}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = hubT('btn_play');
    refreshGameClaim();   // 赢局派彩即时进合约内部余额，刷新可领取额
  }
  return ok;
}

// ============================================================
// 2026-09-29 P1-6 / P1-7 辅助函数
// ============================================================
/** 根据当前下注额估算最大派彩（依赖 ctx.params.multiplier，无则显示 —） */
function updateEstPayout() {
  const el = $('estOut');
  if (!el || !ctx) return;
  const amt = Number($('betAmt').value) || 0;
  const p = (ctx && ctx.params) || {};
  const mult = (typeof p.multiplier === 'number') ? p.multiplier
    : (typeof p.multipliers === 'number') ? p.multipliers
    : (Array.isArray(p.multipliers) ? Math.max(0, ...p.multipliers) : null);
  el.textContent = mult ? (amt * mult).toFixed(2) + ' TKCC' : '—';
}

/** 连续下注：串行执行 N 局，每局重取 nonce（doPlay 内部已 syncFromChain），
 *  失败/停止即终止。绝不暗示必胜。 */
async function autoBetLoop(n) {
  autoBetStop = false;
  const total = Math.min(Math.max(Number(n) || 1, 1), 50);
  const prog = $('autoProgress');
  for (let i = 1; i <= total; i++) {
    if (autoBetStop) { showToast(hubT('auto_stopped'), 'error'); break; }
    if (prog) prog.textContent = `${i}/${total}`;
    const ok = await doPlay();
    if (!ok) { showToast(hubT('auto_stopped') + '：' + hubT('fail_log').replace(/:$/, ''), 'error'); break; }
    if (i < total) await new Promise((r) => setTimeout(r, 600));
  }
  if (prog) prog.textContent = '';
  if (!autoBetStop) showToast(hubT('auto_done'), 'success');
}

// ============================================================
// 本局链上明细（2026-09-28 新增）
// ------------------------------------------------------------
// 背景：一局下注在链上被拆成 3 份，但**只有「运营」那一份会产生 cw20 transfer 事件**：
//   · 下注            → 从合约内余额扣减，内部记账，无事件
//   · 奖池准备金 90%  → 内部记账（HOUSE_BANKROLL），无事件
//   · 销毁       5%   → cw20 burn 事件（不是 transfer）
//   · 运营       5%   → cw20 transfer 事件（钱包唯一能识别的那条）
// 于是钱包把「运营 500」当成整笔交易的金额显示，玩家会误以为金额对不上。
// 这里直接把拆分摆出来，并写清楚原因。数据全部取自 tx 事件，取不到才用配置比例推算。
// ============================================================
function renderTxBreakdown(out, hash, height, betU) {
  const card = $('bdCard');
  if (!card || !ctx) return;

  const econ = ctx.econ || { burnEnabled: true, burnBps: 500, treasBps: 500 };
  const bet = BigInt(out.bet || betU || '0');
  const tk = (v) => `${fromRawUnits(v.toString())} TKCC`;
  const pct = (bps) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 ? 2 : 0)}%`;
  const row = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  let rows = '';
  let note = '';

  if (out.won) {
    const payout = BigInt(out.payout || '0');
    const profit = payout > bet ? payout - bet : 0n;
    rows =
      row(hubT('bd_bet'), tk(bet)) +
      row(hubT('bd_payout'), tk(payout)) +
      row(hubT('bd_profit'), `${tk(profit)}（${hubT('bd_pool')}）`);
    note = hubT('bd_win_note');
  } else {
    let burn = BigInt(out.burnAmount || '0');
    let treas = BigInt(out.treasuryAmount || '0');
    // 事件里没有（老节点/未开销毁）→ 按链上 burn_config / treasury_config 比例推算
    if (burn === 0n && treas === 0n && bet > 0n) {
      burn = (bet * BigInt(econ.burnEnabled ? econ.burnBps : 0)) / 10000n;
      treas = (bet * BigInt(econ.treasBps)) / 10000n;
    }
    const pool = bet > burn + treas ? bet - burn - treas : 0n;
    rows =
      row(hubT('bd_bet'), tk(bet)) +
      row(hubT('bd_burn'), `${tk(burn)}（${pct(econ.burnEnabled ? econ.burnBps : 0)}）`) +
      row(hubT('bd_treasury'), `${tk(treas)}（${pct(econ.treasBps)}）`) +
      row(hubT('bd_pool'), `${tk(pool)}（${pct(Math.max(0, 10000 - (econ.burnEnabled ? econ.burnBps : 0) - econ.treasBps))}）`);
    note = hubT('bd_note');
  }

  $('bdBody').innerHTML = rows;
  $('bdNote').innerHTML = note;
  $('bdHash').textContent = hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : '—';
  $('bdHeight').textContent = height || '—';
  card.style.display = '';
}

// ============================================================
// 2026-09-29 P1-5：每局历史 + 个人统计（纯前端，localStorage，不依赖合约）
//   只存最近 50 局，不触碰链上/合约，不受「不能改合约」限制。
// ============================================================
const HISTORY_KEY = 'paxi_hub_history_v1';
function pushHistory(gameId, item) {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    const list = all[gameId] || [];
    list.unshift(Object.assign({ time: Date.now() }, item));
    all[gameId] = list.slice(0, 50);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch (e) { /* 隐私模式等写入失败，忽略即可 */ }
}
function getHistory(gameId) {
  try { return (JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}')[gameId]) || []; } catch (e) { return []; }
}
/** 汇总今日输赢 / 连胜 / 总下注 / 回报率 */
function computeStats(gameId) {
  const hist = getHistory(gameId);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const todayMs = dayStart.getTime();
  let todayWin = 0n, totalBet = 0n, wonBet = 0n, streak = 0, maxStreak = 0;
  for (const h of hist) {
    const bet = BigInt(Math.round(Number(h.bet) * 1e6));
    const payout = BigInt(Math.round(Number(h.payout || '0') * 1e6));
    totalBet += bet;
    if (h.time >= todayMs) todayWin += (payout - bet);
    if (h.won) { wonBet += bet; streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }
  const roi = totalBet > 0n ? Number((wonBet * 10000n) / totalBet) / 100 : 0; // 赢局本金占比（%）
  return {
    todayWinStr: fromRawUnits(todayWin.toString()),
    streak: maxStreak,
    totalBetStr: fromRawUnits(totalBet.toString()),
    roi: roi.toFixed(1) + '%',
  };
}
/** 渲染历史卡片（最近 15 局 + 统计行） */
function renderHistory(gameId) {
  const box = $('histBody');
  if (!box) return;
  const hist = getHistory(gameId).slice(0, 15);
  const st = computeStats(gameId);
  const rows = hist.length ? hist.map((h) => {
    const d = new Date(h.time);
    const t = `${String(d.getMonth() + 1)}/${String(d.getDate())} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const w = h.won;
    return `<div class="kv hist-row ${w ? 'h-win' : 'h-lose'}">
      <span class="k">${w ? '🟢' : '🔴'} ${h.bet} TKCC</span>
      <span class="v">${w ? '+' + (h.payout || '0') : '0'} · ${esc(String(h.result || (w ? 'win' : 'lose')).slice(0, 18))}</span>
      <span class="t">${t}</span>
    </div>`;
  }).join('') : `<div class="desc">${hubT('hist_empty')}</div>`;
  box.innerHTML =
    `<div class="stat-row">
      <span>📈 ${hubT('stat_today')}: <b>${st.todayWinStr} TKCC</b></span>
      <span>🔥 ${hubT('stat_streak')}: <b>${st.streak}</b></span>
      <span>💰 ${hubT('stat_total_bet')}: <b>${st.totalBetStr}</b></span>
      <span>📊 ${hubT('stat_roi')}: <b>${st.roi}</b></span>
    </div>` + rows;
}

// ============================================================
// 游戏页「领取奖励」（大厅通用游戏：猜数字 / 骰宝 / 疯狂骰子）
// ------------------------------------------------------------
// 合约行为：这些游戏没有 pending/claim 机制，赢局的 payout 会**即时**加进合约内部
// BALANCES（从 HOUSE_BANKROLL 扣 profit），所以要拿回钱包必须发 Withdraw。
// 这里补一个「领取奖励」卡片 = 一键 Withdraw 全部合约内余额，避免玩家赢完找不到入口。
// ============================================================

/** 下注用的代币 = 配置的 TKCC；没配 TKCC 时退回钱包页当前选中代币 */
function gameClaimToken() {
  const list = state.tokens && state.tokens.length ? state.tokens : [NATIVE_TOKEN];
  if (CONTRACTS.tkcc) {
    const t = list.find((x) => x.type === 'cw20' && x.contract === CONTRACTS.tkcc);
    if (t) return t;
    return { key: 'cw20:' + CONTRACTS.tkcc, type: 'cw20', contract: CONTRACTS.tkcc, symbol: 'TKCC', decimals: 6, name: 'TKCC' };
  }
  return findToken(list, state.selToken);
}

/** 拉取合约内余额并刷新「领取奖励」卡片（无余额则整卡隐藏） */
async function refreshGameClaim() {
  const card = $('gameClaimCard');
  if (!card || !state.connected || !hasGameContract()) return;
  const t = gameClaimToken();
  const balEl = $('gcBal');
  const btn = $('btnGameClaim');
  if (balEl) balEl.textContent = hubT('claim_loading');
  try {
    const bal = await queryGameBalance(t);
    gameClaimBal = bal;
    if (balEl) balEl.textContent = `${bal} ${esc(t.symbol)}`;
    const zero = !bal || Number(bal) <= 0;
    if (btn) {
      btn.disabled = zero;
      btn.textContent = zero ? hubT('claim_empty') : hubT('claim_btn');
    }
    card.style.display = '';   // 常驻显示：余额为 0 时按钮置灰提示，避免玩家找不到入口
  } catch (e) {
    console.warn('查询合约内余额失败', e && e.message);
    if (balEl) balEl.textContent = '—';
    card.style.display = '';
  }
}

/** 一键把合约内余额全部提现回钱包（等价于「领取奖励」） */
async function claimGameReward() {
  if (!state.connected) return showToast(hubT('connect_wallet_first'), 'error');
  const t = gameClaimToken();
  const btn = $('btnGameClaim');
  let amt = gameClaimBal;
  try {
    amt = await queryGameBalance(t);   // 以链上最新为准，别用缓存值
  } catch (e) {
    return showToast(hubT('claim_loading') + '：' + (e.message || e), 'error');
  }
  gameClaimBal = amt;
  if (!amt || Number(amt) <= 0) return showToast(hubT('claim_empty'), 'error');

  const raw = toRawUnits(amt, t.decimals);
  if (BigInt(raw) <= 0n) return showToast(hubT('claim_empty'), 'error');

  if (btn) { btn.disabled = true; btn.textContent = hubT('processing'); }
  showBusy(hubT('claim_btn') + '…');
  try {
    const hash = await execContract({
      withdraw: { token: t.type === 'native' ? null : t.contract, amount: raw },
    });
    await waitForTx(hash);
    log(`${hubT('claim_ok')} ${amt} ${esc(t.symbol)}`, 'ok');
    showToast(hubT('claim_ok'), 'success');
    await refreshBalances();
  } catch (e) {
    const msg = e.message || String(e);
    log('领取失败：' + msg, 'err');
    showToast(msg, 'error');
  } finally {
    hideBusy();
    await refreshGameClaim();
    if (btn) btn.disabled = false;
  }
}

// ============================================================
// 启动
// ============================================================
async function boot() {
  // 恢复上次选择的语言
  try {
    const s = localStorage.getItem('paxi_hub_lang');
    if (s === 'en' || s === 'zh') window.HUB_LANG = s;
  } catch (e) {}
  applyHubLang();

  updateHeader();
  // 🟢 首屏：合约已配置时不渲染大厅 —— boot 尾部会 openSanguo() 直进三国；
  //    renderHome 是 async（内部 await Session.syncFromChain），它的续体会
  //    晚于 openSanguo 把「选择游戏」大厅覆盖回来，导致每次打开都要再点一次。
  //    只有合约未配置时才首屏渲染引导大厅。
  if (!hasGameContract()) renderHome();

  // 自动连接（PaxiHub 内置浏览器里静默完成，不弹窗）
  await connectWallet(true);

  // 恢复本地会话密钥
  try {
    await Session.load();
  } catch (e) {}

  if (!hasGameContract()) {
    if (currentTab === 'home') renderHome();   // 内部会显示配置引导
    return;
  }

  // 拉代币列表（原生 PAXI + 合约白名单 PRC-20 + 手动添加的）
  try {
    await loadTokens();
  } catch (e) {
    console.warn('代币列表加载失败', e);
  }

  // 拉游戏列表（大厅卡片显示限额）
  try {
    const r = await queryContract({ list_games: {} });
    state.games = r.games || [];
  } catch (e) {
    console.warn('list_games 失败', e);
  }

  // 会话状态
  try {
    await Session.syncFromChain();
  } catch (e) {}

  // 🟢 合规版（2026-10-10）：启动后直进「三国·卡牌」，不再停留大厅。
  //    仅当 openSanguo 不可用（异常情况）才兜底渲染大厅；理由同上 ——
  //    大厅渲染晚于/并发于 openSanguo 都会把三国页覆盖掉。
  if (currentTab === 'home' && typeof window.openSanguo === 'function') {
    try { window.openSanguo(); } catch (e) { console.warn('openSanguo 失败', e); renderHome(); }
  } else if (currentTab === 'home') {
    renderHome();
  }

  // 🟢 会话到期前提示（剩余 < 2 小时提醒续期）
  (async function checkSeamlessExpiry() {
    try {
      // 会话（24h）到期检查
      const info = state.sessInfo;
      if (info && info.expires_at) {
        const nowSec = Math.floor(Date.now() / 1000);
        const hoursLeft = (Number(info.expires_at) - nowSec) / 3600;
        if (hoursLeft > 0 && hoursLeft < 2) {
          showToast('无感会话将在 2 小时内到期，请到「我的」续期', 'error');
        }
      }
      // 🟢 5A：Feegrant（7d）到期独立检查
      if (window.Session && typeof Session.getFeegrant === 'function' && state.wallet) {
        const fg = await Session.getFeegrant();
        if (fg && fg.ok && fg.expiration) {
          const fgHours = (fg.expiration - Date.now()) / 3600000;
          if (fgHours > 0 && fgHours < 24) {
            showToast(`Gas 代付授权将在 ${fgHours.toFixed(1)} 小时后到期，请到「我的」重新开启无感模式`, 'error');
          }
        }
      }
    } catch (e) {}
  })();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
