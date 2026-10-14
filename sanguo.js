// 本轮改动（R12）：sanguoExec 中 Session.sign 调用补 await（@noble/secp256k1@2.x 的 sign 为异步，不 await 会得到空串签名）。
/**
 * 🀄 三国卡牌前端子系统（新通用合约版）
 * --------------------------------------------------------------
 * 设计原则（按用户要求）：
 *   1. 所有卡牌地址（image_url）与玩法逻辑沿用原始三国源码，不改动。
 *   2. 底层合约调用改为新统一合约的 Sanguo* 消息 + 会话无感签名
 *      （复用 games/mod.rs::validate_and_consume_session）。
 *   3. 完整玩法已恢复：抽卡 / 我的卡 / AI 对战 / 养成 / 提案 / PVP / 混战
 *      七个页签，全部走无感签名（session key），仅会话注册时钱包弹一次。
 *      合约侧 msg.rs / exec.rs / query.rs / mod.rs / error.rs / state.rs
 *      已全部恢复并经 cargo check 通过（按用户要求不编译 wasm）。
 *
 * 签名原文（与合约一致）：
 *   "{chain_id}:{contract}:sanguo:{action}:{round_id}:{spend}:{nonce}:{pubkey}"
 *   裸 SHA-256 → secp256k1 compact 签名（64 bytes hex）。
 */

(function () {
  'use strict';

  // ============================================================
  // 卡牌数据（与原始三国源码逐字一致，不改动地址 / 属性）
  // ============================================================
  const CARD_TEMPLATES = [
    { name: '曹操', title: '魏武挥鞭', rarity: 'legend', attack: 105, defense: 95, identity: '魏·武帝' },
    { name: '诸葛亮', title: '卧龙出山', rarity: 'legend', attack: 110, defense: 90, identity: '蜀·丞相' },
    { name: '关羽', title: '武圣降世', rarity: 'legend', attack: 115, defense: 85, identity: '蜀·五虎将' },
    { name: '赵云', title: '常山龙胆', rarity: 'legend', attack: 100, defense: 100, identity: '蜀·五虎将' },
    { name: '吕布', title: '飞将无双', rarity: 'legend', attack: 120, defense: 80, identity: '汉·温侯' },
    { name: '司马懿', title: '冢虎沉谋', rarity: 'legend', attack: 95, defense: 110, identity: '魏·太傅' },
    { name: '张飞', title: '当阳怒吼', rarity: 'epic', attack: 95, defense: 75, identity: '蜀·五虎将' },
    { name: '马超', title: '锦马超', rarity: 'epic', attack: 90, defense: 80, identity: '蜀·五虎将' },
    { name: '黄忠', title: '百步穿杨', rarity: 'epic', attack: 85, defense: 85, identity: '蜀·五虎将' },
    { name: '姜维', title: '麒麟之志', rarity: 'epic', attack: 88, defense: 82, identity: '蜀·大将军' },
    { name: '周瑜', title: '赤壁东风', rarity: 'epic', attack: 80, defense: 90, identity: '吴·大都督' },
    { name: '陆逊', title: '火烧连营', rarity: 'epic', attack: 82, defense: 88, identity: '吴·大都督' },
    { name: '夏侯惇', title: '拔矢啖睛', rarity: 'epic', attack: 92, defense: 78, identity: '魏·大将军' },
    { name: '张辽', title: '威震逍遥', rarity: 'epic', attack: 88, defense: 82, identity: '魏·五子良将' },
    { name: '魏延', title: '汉中镇守', rarity: 'rare', attack: 75, defense: 70, identity: '蜀·镇北将军' },
    { name: '庞统', title: '凤雏落凤', rarity: 'rare', attack: 70, defense: 75, identity: '蜀·军师中郎将' },
    { name: '法正', title: '睚眦必报', rarity: 'rare', attack: 68, defense: 72, identity: '蜀·尚书令' },
    { name: '甘宁', title: '锦帆贼', rarity: 'rare', attack: 80, defense: 60, identity: '吴·折冲将军' },
    { name: '太史慈', title: '北海救孔', rarity: 'rare', attack: 72, defense: 68, identity: '吴·建昌都尉' },
    { name: '孙策', title: '小霸王', rarity: 'rare', attack: 78, defense: 62, identity: '吴·讨逆将军' },
    { name: '吕蒙', title: '吴下阿蒙', rarity: 'rare', attack: 65, defense: 75, identity: '吴·大都督' },
    { name: '邓艾', title: '阴平奇兵', rarity: 'rare', attack: 70, defense: 70, identity: '魏·征西将军' },
    { name: '廖化', title: '蜀中先锋', rarity: 'common', attack: 50, defense: 45, identity: '蜀·车骑将军' },
    { name: '简雍', title: '雍容辩士', rarity: 'common', attack: 40, defense: 50, identity: '蜀·昭德将军' },
    { name: '孙乾', title: '雍容辩士', rarity: 'common', attack: 38, defense: 48, identity: '蜀·秉忠将军' },
    { name: '糜竺', title: '富商军师', rarity: 'common', attack: 42, defense: 42, identity: '蜀·安汉将军' },
    { name: '诸葛瑾', title: '敦厚长者', rarity: 'common', attack: 45, defense: 55, identity: '吴·大将军' },
    { name: '鲁肃', title: '单刀赴会', rarity: 'common', attack: 48, defense: 52, identity: '吴·横江将军' },
    { name: '程昱', title: '兖州谋主', rarity: 'common', attack: 44, defense: 46, identity: '魏·卫尉' },
    { name: '贾诩', title: '毒士乱武', rarity: 'common', attack: 46, defense: 44, identity: '魏·太尉' },
  ];

  // 卡牌图片统一托管在 GitHub Pages：assets/cards/<名字>.webp（20261014-7 由 PNG 转制，体积 1/10）
  // 原始 30 张与新增 30 张均已自托管，不再依赖第三方图床（消除图床删图/防盗链导致裂图隐患）
  const CARD_IMAGE_BASE = 'https://moxiaomo856.github.io/paxi-card-game/assets/cards/';

  // ============================================================
  // 多语言（沿用原始三国词库；同时响应大厅全局语言切换）
  // ============================================================
  const i18n = {
    zh: {
      'sg_title': '🀄 逐雄三国2.0',
      'sg_subtitle': '合规休闲卡牌：免费抽卡、买卡买碎片、9v9 三组对战，不涉及代币博弈。',
      'tab_draw': '🎴 抽卡',
      'tab_mycards': '🃏 我的卡',
      'draw_single': '🗡️ 单抽',
      'draw_pack3': '🎴 三连抽',
      'draw_single_title': '🗡️ 单抽（1 张）',
      'draw_pack3_title': '🎴 三连抽（3 张）',
      'cost_label': '消耗',
      'bal_title': '💰 余额',
      'bal_tkcc': '合约内 TKCC',
      'loading': '加载中…',
      'my_cards': '我的卡牌',
      'my_cards_desc': '所有已拥有的武将卡牌，永久保存。',
      'empty_cards': '点击「抽卡」获取卡牌',
      'power_label': '战力',
      'insufficient': '余额不足，请先充值 TKCC',
      'connect_first': '请先连接钱包',
      'params_err': '无法读取三国合约参数，请检查合约地址与网络连接后重试',
      'draw_doing': '抽卡中…',
      'draw_ok': '成功！新卡已入账',
      'draw_ok_short': '抽卡成功！',
      'draw_fail': '抽卡失败：',
      'register_session': '注册会话…',
      'back_home': '← 游戏大厅',
      'contract_missing': '请先在「我的」填写合约地址',
      // ---- 第七轮恢复：完整玩法页签 ----
      'tab_ai': 'AI 对战',
      'tab_cultivate': '养成',
      'tab_proposal': '提案',
      'tab_pvp': 'PVP',
      'tab_royale': '混战',
      'tab_ledger': '📊 收入对账',
      // ---- 🎁 赠送系统 ----
      'tab_gift': '🎁 赠送',
      'gift_title': '🎁 赠送好友',
      'gift_desc': '把卡牌 / 碎片 / 皮肤送给同场对战过、且认识满 30 天的好友。',
      'gift_to': '接收方地址',
      'gift_to_ph': 'paxi1... 好友的钱包地址',
      'gift_kind': '赠送类型',
      'gift_kind_card': '卡牌',
      'gift_kind_frag': '碎片',
      'gift_kind_skin': '皮肤',
      'gift_card': '选择卡牌',
      'gift_rarity': '稀有度',
      'gift_amount': '数量',
      'gift_skin': '选择皮肤',
      'gift_send': '赠送',
      'gift_status': '我的赠送状态',
      'gift_acct_age': '账号龄',
      'gift_pair_ok': '关系达标',
      'gift_sent_today': '今日已送',
      'gift_recv_today': '今日已收',
      'gift_hold': '冷静期(普通/传说)',
      'gift_select_to': '请输入接收方地址',
      'gift_invalid_addr': '地址格式错误（应以 paxi1 开头）',
      'gift_no_card': '暂无可赠送的卡牌',
      'gift_no_skin': '暂无可赠送的皮肤',
      'gift_amount_err': '请输入正确的碎片数量',
      'gift_ok': '赠送成功！',
      'gift_fail': '赠送失败：',
      'gift_status_err': '无法读取赠送状态',
      'gift_rules': '规则：账号≥30天 · 关系≥30天 · 资产冷静期30天(传说7天) · 每日送≤3/收≤5 · 单笔碎片≤30',

      // ---- 合规版：商店 / 关卡 / 免费抽卡 ----
      'tab_shop': '🛒 商店',
      'tab_stage': '🗺️ 关卡',
      'draw_free_title': '🎴 免费抽卡',
      'draw_free_desc': '合规版抽卡完全免费，不消耗任何 PAXI / TKCC。',
      'draw_remaining': '今日剩余次数',
      'draw_free_done': '今日免费次数已用完，明天再来！',
      'draw_not_migrated': '⚠️ 当前合约尚未迁移到合规版（v0.1.1），免费抽卡暂不可用。下图展示的是合规版界面预览，合约迁移完成后将自动开启、可正常免费抽卡。',
      'shop_title': '🛒 武将商店',
      'shop_desc': '明码标价、付钱即得（确定性购买，无随机、无赔付）。',
      'shop_cards': '直接买卡（1★ Lv0 成品卡）',
      'shop_frags': '碎片包（每包 {n} 个）',
      'shop_buy': '购买',
      'shop_packs': '购买包数',
      'shop_buying': '购买中…',
      'shop_ok': '购买成功！',
      'shop_fail': '购买失败：',
      'shop_price_na': '价格未配置',
      'shop_frag_ok': '已获得 {n} 个{r}碎片！',
      'shop_card_ok': '已购入「{name}」！',
      'stage_title': '🗺️ 关卡挑战',
      'stage_desc': '编成 9 张卡（3 张一组 × 3 组）挑战关卡，合约链上复算，通关发碎片。',
      'stage_pick': '出战编队（9 张，顺序即 1-3 / 4-6 / 7-9 三组）',
      'stage_need9': '需要 9 张卡',
      'stage_submit': '挑战',
      'stage_submitting': '战斗结算中…',
      'stage_ok': '通关成功！奖励碎片已入账',
      'stage_fail': '挑战失败：',
      'stage_cleared_already': '该关卡已通关',
      'stage_no_stages': '暂无关卡，等待运营配置',
      'stage_reward': '通关奖励',
      'stage_wins': '组比分',
      'order_max9': '最多 9 张（3 组 × 3 张）',
      'ai_title': 'AI 对战',
      'ai_desc': '选择难度挑战 AI，免费参与，胜则赢取碎片奖励',
      'ai_diff': '难度',
      'ai_fee': '挑战费',
      'ai_reward': '胜率奖励',
      'win_frag': '赢取碎片',
      'free_entry_ok': '免费完成，赢取碎片奖励',
      'claim_frag': '领取成功，获得碎片：{frag}',
      'ai_pending_hint': '你已赢 {n} 场，奖励需点击下方按钮领取后才会到钱包。',
      'ai_stats': '今日已战',
      'cult_title': '养成',
      'cult_desc': '升星 / 分解 / 升级 / 合成 / 出战顺序',
      'frag_title': '碎片',
      'rarity_common': '普通',
      'rarity_rare': '稀有',
      'rarity_epic': '史诗',
      'rarity_legend': '传说',
      'order_title': '出战顺序',
      'set_order_btn': '设置顺序',
      'starup_btn': '升星',
      'decompose_btn': '分解',
      'upgrade_btn': '升级',
      'decompose_confirm': '确定要分解这张卡牌吗？\n分解后卡牌消失、获得对应碎片，不可恢复！',
      'select_rarity': '选择稀有度',
      'craft_btn': '合成',
      'craft_desc': '消耗对应稀有度碎片，随机获得一张该稀有度卡牌。',
      'craft_common': '🟤 合成普通（{cost} 碎片）',
      'craft_rare': '🔵 合成稀有（{cost} 碎片）',
      'craft_epic': '🟣 合成史诗（{cost} 碎片）',
      'craft_legend': '🟡 合成传说（{cost} 碎片）',
      'craft_insufficient': '碎片不足：需要 {need}，当前 {have}',
      'select_card_first': '请先选择卡牌',
      'prop_title': '卡牌提案',
      'prop_desc': '提交新武将卡，社区投票通过后上链',
      'prop_propose': '提交新卡提案',
      'prop_name': '卡牌名',
      'prop_attack': '攻击',
      'prop_defense': '防御',
      'prop_weight': '权重',
      'prop_submit': '提交提案',
      'prop_list': '提案列表',
      'prop_votes': '票数',
      'prop_approved': '已通过',
      'prop_rejected': '已否决',
      'prop_open': '投票中',
      'prop_vote_yes': '赞成',
      'prop_vote_no': '反对',
      'prop_execute': '执行',
      'prop_cancel': '撤销',
      'pvp_title': 'PVP 1v1',
      'pvp_desc': '与好友 1v1 对战，免费参与，胜则赢取碎片',
      'pvp_create': '创建对战',
      'pvp_opponent': '对手地址',
      'pvp_public': '公开匹配',
      'pvp_list': '对战列表',
      'pvp_accept': '接受',
      'pvp_cancel': '取消',
      'pvp_claim': '领取',
      'royale_title': '混战',
      'royale_desc': '4-6 人混战，免费参与，胜则赢取碎片',
      'royale_create': '创建混战',
      'royale_size': '人数',
      'royale_join': '加入',
      'royale_settle': '结算',
      'royale_claim': '领取',
      'royale_list': '混战列表',
      'pending_reward': '待领取奖励',
      'claim_btn': '领取',
      'doing': '处理中…',
      'ok_short': '成功',
      'fail_prefix': '操作失败：',
      'need_connect': '请先连接钱包并选择卡牌',
      // ---- 第七轮恢复：补充文案 ----
      'ai_today': '今日已战',
      'ai_limit': '每日上限',
      'win_rate': '胜率',
      'order_max': '出战顺序最多 9 张（3 组 × 3 张）',
      'selected_label': '已选',
      'prop_id': '卡牌 ID',
      'prop_status': '状态',
      'prop_yes': '赞成票',
      'prop_no': '反对票',
      'prop_deadline': '截止',
      'deposit_label': '提案押金',
      'none_label': '暂无',
      'match_id_label': '对局',
      'status_label': '状态',
      'opponent_label': '对手',
      'winner_label': '胜者',
      'reward_label': '奖励',
      'pick_title': '选择卡牌',
      'create_ok': '已创建',
      'accept_ok': '已接受',
      'join_ok': '已加入',
      'settle_ok': '已结算',
      'execute_ok': '已执行',
      'cancel_ok': '已撤销',
      'propose_ok': '提案已提交',
      'vote_ok': '投票成功',
      'claim_ok': '已领取',
      // ---- 到账/消耗金额提示（前端自解析交易事件，绕开钱包把 burn 当到账显示的问题） ----
      'claim_in': '✅ 已到账 {amt} TKCC',
      'claim_in_burn': '✅ 已到账 {amt} TKCC（合约另销毁 {burned} TKCC）',
      'spent_tip': '✅ {what} · 本次消耗 {amt} TKCC（合约内余额扣除）',
      'need_three': '请先选择 3 张卡牌',
      'need_nine': '请先选择 9 张卡牌',
      'pick_limit': '请先选择 {n} 张卡牌',
      'team_cost_over': '编队 cost 超上限：{total} > {cap}，请更换部分卡牌后重试',
      'tab_battleparams': '战斗参数',
      'bp_title': '战斗系数热更',
      'bp_desc': '管理员专用：改完点「保存」全量上链即时生效（填 0 = 回退默认）。技能/连携强度为全局系数：10000 = 100%，上限 30000（3×）。阵营克制链 wei→shu→wu→qun→wei；兵种克制链 骑→弓→军师→守→骑。',
      'bp_default': '默认',
      'bp_json_title': '完整参数 JSON（高级）',
      'bp_json_hint': '表单改动自动同步进 JSON；也可直接编辑后保存（服务端会强制归零废弃计费字段）。',
      'bp_save': '保存参数上链',
      'bp_save_ok': '战斗参数已更新',
      'bp_invalid_json': 'JSON 格式错误，请检查后重试',
      'bp_faction_counter_bp': '阵营克制加成',
      'bp_faction_countered_bp': '阵营被克减益',
      'bp_faction_neutral_bp': '阵营中性',
      'bp_troop_counter_bp': '兵种克制加成',
      'bp_troop_countered_bp': '兵种被克（默认无惩罚）',
      'bp_troop_neutral_bp': '兵种中性',
      'bp_rarity_legend_bp': '传说系数',
      'bp_rarity_epic_bp': '史诗系数',
      'bp_rarity_rare_bp': '稀有系数',
      'bp_rarity_common_bp': '普通系数',
      'bp_power_flat_cap_bp': '战力 flat 封顶',
      'bp_eff_lower_bound_bp': '攻防减益下限',
      'bp_skill_strength_bp': '技能强度（全局）',
      'bp_bond_strength_bp': '连携强度（全局）',
      'troop_cavalry': '骑兵',
      'troop_archer': '弓兵',
      'troop_strategist': '谋士',
      'troop_guard': '守卫',
      'skill_locked': '技能「{name}」（3★ 解锁）',
      'bond_label': '连携',
      'bond_active': '{name} +{bp}%（{cnt}/{need} 张）',
      'help_battle_title': '战斗规则（9v9 三组）',
      'help_battle_desc': '无随机数：双方出牌后由链上引擎确定性结算。战力 = (攻+防) × (1+flat) × 阵营 × 兵种 × 连携 × 稀有度。',
      'help_faction_chain': '阵营克制',
      'help_faction_chain_v': '魏→蜀→吴→群→魏（克 +15% / 被克 −10%）',
      'help_troop_chain': '兵种克制',
      'help_troop_chain_v': '骑→弓→谋→守→骑（克 +10% / 被克无惩罚）',
      'help_skill_rule': '技能',
      'help_skill_rule_v': '3★ 解锁；触发时机：开战 / 每组开始 / 赢组 / 输组 / 战力低 / 战力高',
      'help_bond_rule': '连携',
      'help_bond_rule_v': '按全队成员数激活，只取最高单档（如五虎上将 3 张 +8%、5 张 +18%）',
      'help_mystats_title': '我的战绩',
      'help_mystats_desc': '链上按钱包地址累计，换设备不清空；格式：对战 / 胜。',
      'help_mystats_all': '合计（全部模式）',
      'help_mystats_ai': 'AI 对战（休闲+天梯）',
      'help_mystats_pvp': 'PVP 单挑',
      'help_mystats_royale': '混战',
      'help_mystats_stage': '关卡（仅通关计数）',
      'help_coeff': '当前生效系数（链上参数）',
      'help_coeff_hint': '0 值自动回退默认；管理员可在「战斗参数」页热更',
      'battle_group': '第 {n} 组',
      'group_win': '胜',
      'group_lose': '负',
      'group_draw': '平',

      // ---- 老合约资产迁移 ----
      'migrate_title': '老合约资产迁移',
      'migrate_desc': '把老三国合约里的卡牌（保留稀有度/攻防/星级/等级）和碎片一次性迁移到新合约。每个钱包只能迁移一次。',
      'migrate_btn': '一键迁移',
      'migrate_doing': '迁移中…',
      'migrate_ok': '迁移完成',
      'migrate_done': '该钱包已迁移过，无需重复操作',
      'migrate_opening': '管理员尚未开放迁移入口',
      'migrate_none': '老合约里没有可迁移的卡牌或碎片',
      // ---- 迁移上限说明（gas 容量约束）----
      'migrate_limit_note': '⚠️ 单次最多迁移 30 张卡（gas 容量上限）。老合约卡牌超过 30 张的，请先在老合约里把多余的卡分解掉，再回来迁移。每个钱包只有一次迁移机会，但迁移失败不会消耗这次机会。',
      'migrate_over_limit': '老合约有 {n} 张卡，超过单次上限 {max} 张。请先在老合约分解掉 {over} 张后再迁移（分解后本提示会自动刷新）。',
      'migrate_gas_hint': '本次按 {n} 张卡设置 gas 上限 {gas}（手续费按声明上限全额扣，未用完不退还）。',
      'migrate_no_preview': '（未能读取老合约卡数，已按 {max} 张卡的上限准备 gas）',
      'migrate_blocked': '老合约卡数超限，请先分解后再迁移',
      'migrate_old_summary': '老合约：{n} 张卡 · 碎片(普/稀/史/传) {fg}',
      'migrate_ok_detail': '✅ {msg}：{minted} 张卡，{frags} 碎片{skipped}',
      'migrate_ok_skip': '（跳过 {n}）',

      // ---- 统计卡 / 图鉴 ----
      'sg_stat_wins': '胜场', 'sg_stat_cards': '总卡牌', 'sg_stat_battles': '总对战', 'sg_stat_frag': '碎片',
      'codex_open': '📚 卡牌图鉴（{n} 将）',
      'codex_progress': '收集进度：{own} / {total}（点击卡牌查看详情）',
      'codex_not_owned': '未拥有',
      'codex_search': '搜索武将 / 称号',
      'codex_collect': '收藏',
      'codex_empty': '没有匹配的卡牌',
      'sort_power': '按战力',
      'sort_atk': '按攻击',
      'sort_def': '按防御',
      'sort_name': '按名称',
      'batch_decompose': '批量分解',
      'batch_decompose_do': '分解选中',
      'batch_none': '请先勾选要分解的卡牌',
      'batch_decompose_confirm': '确定批量分解 {n} 张卡牌吗？\n分解后卡牌永久消失、返还碎片，不可恢复！',
      'batch_decompose_ok': '已分解 {n} 张卡牌',
      'selected': '已选',
      'cancel': '取消',

      // ---- 卡牌详情 ----
      'detail_title_wrap': '「{t}」',
      'detail_stats': '{identity}{title}　攻击 {atk} · 防御 {def} · 战力 {pow}',

      // ---- AI 出战选择 ----
      'ai_my_cards': '我的卡牌',
      'ai_pick_title': '🃏 选择出战卡牌',
      'ai_pick_desc': '最多选 3 张，顺序即出牌顺序（第 1 张先出）。不选则沿用你已有的出战顺序。',
      'ai_need_three_btn': '需至少 3 张卡牌',
      'ai_need_three_hint': '❌ AI 对战需要至少 3 张卡牌，请先去「抽卡」获得卡牌后再来挑战。',
      'ai_need_three_msg': 'AI 对战需要至少 3 张卡牌，请先去「抽卡」获得卡牌后再来挑战。',
      'order_saved': '出牌顺序：{names}',

      // ---- 对战竞技场 ----
      'battle_result_title': '⚔️ 对战结果',
      'battle_win': '🏆 胜利！', 'battle_lose': '💀 失败', 'battle_draw': '🤝 平局',
      'battle_you': '你', 'battle_opp': '对手',
      'battle_deployed': '（出战）',
      'battle_reward': '奖励：{amt} TKCC',
      'battle_frag_reward': '赢取碎片：{frag}',
      'battle_rounds': '三局 {n} 胜',
      'battle_challenger': '挑战方', 'battle_defender': '应战方',
      'battle_ai_general': 'AI 战将', 'battle_ai_diff': 'AI 难度 {n}',

      // ---- 技能触发回放（V2.1：链上 skill_log 事件）----
      'skill_log_title': '🎯 技能触发回放',
      'skill_log_empty': '本场无技能触发',
      'skill_log_side_a': 'A 方', 'skill_log_side_b': 'B 方',
      'skill_log_team_wide': '全队',
      'trg_on_battle_start': '开战', 'trg_on_group_start': '每组开始',
      'trg_on_win_group': '赢一组', 'trg_on_lose_group': '输一组',
      'trg_on_low_power': '战力偏低', 'trg_on_high_power': '战力占优',
      'tgt_self': '己方', 'tgt_opponent': '对手',

      // ---- 抽卡余额不足 ----
      'draw_mode_single': '单抽', 'draw_mode_pack3': '三连抽',
      'draw_paxi_lack': '合约内 PAXI 不足：{mode}需要 {need} PAXI，当前只有 {have} PAXI，请先充值至少 {lack} PAXI',

      // ---- 升星 / 升级 / 分解 ----
      'err_card_notfound': '找不到该卡牌，请刷新「我的卡」后重试',
      'err_max_star': '⭐ 该卡已满星（5★），无法继续升星',
      'err_bal_query': '查询合约内余额失败，请稍后重试',
      'err_tkcc_star': '合约内 TKCC 不足：{from}★→{to}★ 需要 {need} TKCC，当前 {have} TKCC，请先在「钱包」充值',
      'confirm_star_up': '升星 {from}★ → {to}★\n\n费用：{fee} TKCC（从合约内余额扣）\n其中销毁 {half} + 资金池 {half}\n\n确定 = 升星，取消 = 中止',
      'err_frag_star': '碎片不足：碎片升星需要 {need} 个{rarity}碎片，当前 {have} 个（碎片升星不花 TKCC）',
      'confirm_star_frag': '碎片升星 {from}★ → {to}★\n\n消耗 {need} 个{rarity}碎片（不花 TKCC、不销毁）\n当前拥有 {have} 个\n\n确定 = 升星，取消 = 中止',
      'err_max_level': '💠 该卡已满级（Lv10），无法继续升级',
      'err_frag_level': '碎片不足：升级 Lv{from}→Lv{to} 需要 {need} 个{rarity}碎片，当前 {have} 个',
      'err_sig_format': '会话签名异常（签名为空）——通常是浏览器缓存了旧版脚本，请强制刷新页面（或清除缓存）后重试',
      'confirm_level_up': '升级 Lv{from} → Lv{to}\n\n消耗 {need} 个{rarity}碎片\n收益：攻击 +3 · 防御 +2（战力 +5）\n当前拥有 {have} 个\n\n确定 = 升级，取消 = 中止',
      'confirm_decompose': '⚠️ 分解后该卡将永久消失！\n\n「{name}」{star}★ Lv{lv}\n仅返还 {back} 个{rarity}碎片\n（不退还已投入的星级/等级/费用，养成后分解=白烧钱）\n\n确定 = 分解，取消 = 保留',

      // ---- 管理员对账页 ----
      'ledger_loading': '查询中…',
      'ledger_scanning': '⏳ 正在逐笔解析链上抽卡事件…',
      'ledger_rpc_limited': '⚠️ 逐笔统计需访问链节点(RPC)，当前环境受限（如在手机钱包内打开）。请在桌面浏览器打开本页以查看逐笔收到。',
      'ledger_scan_ok': '✅ 已逐笔解析全部抽卡交易（链上为准）。',
      'ledger_scan_fail': '⚠️ 逐笔解析不可用，下列“收到”列为 — 。',
      'ledger_th_addr': '抽水地址', 'ledger_th_count': '笔数', 'ledger_th_paxi': '收到 PAXI', 'ledger_th_tkcc': '收到 TKCC',
      'ledger_total': '合计',
      'ledger_total_burn': '游戏合约累计销毁 TKCC',
      'ledger_burn_desc': '销毁为真实 burn（token 永久消失），不进任何钱包；与每笔抽卡 TKCC 的 40% 一致。',
      'ledger_wallet_note': '说明：钱包/Ping.pub 对 PRC-20 的 wasm 转账事件解析有误（常把 10 PAXI 错标成 10 TKCC、漏显 12 万 TKCC）。本页直接读链上事件，数字与链一致。',
      'ledger_done': '✅ 完成，共 {n} 个抽水地址',
      'ledger_admin_only': '⛔ 此页面仅管理员可见。',
      'ledger_title': '📊 收入对账（管理员）',
      'ledger_desc': '逐笔解析 {n} 个抽水地址的抽卡 wasm 事件，显示真实收到的 PAXI + TKCC（链上为准，不受钱包显示影响）。含游戏合约累计销毁。',
      'ledger_refresh': '🔄 刷新对账',
      'ledger_hint_click': '点击「刷新对账」开始加载…',

      // ---- 🆕 新玩法：天梯 / 皮肤 / 通行证 / 体力 / 每日任务 ----
      'tab_ranked': '🏅 天梯',
      'tab_dailytask': '📅 每日任务',
      'shop_stamina': '体力',
      'shop_stamina_desc': '每 5 分钟自动恢复 1 点（上限 120）；不足时可购买立即补充。',
      'shop_stamina_now': '当前体力',
      'shop_stamina_max': '上限',
      'shop_stamina_buy': '购买体力',
      'shop_stamina_pack': '每包 +30',
      'shop_skins': '皮肤（纯外观）',
      'shop_skins_desc': 'PAXI 购买，纯外观不可转让，拥有即永久可用。',
      'shop_skin_owned': '✅ 已拥有',
      'shop_skin_buy': '购买',
      'shop_season': '赛季通行证',
      'compliance_disabled': '🛡️ 该对战玩法暂不可用。合规版 AI 对战/PVP/混战均为免费入场 + 赢取碎片。',
      'tab_help': '玩法说明',
      'help_title': '逐雄三国2.0 · 玩法说明',
      'help_intro': '本游戏为合规版本：全程不使用 TKCC，所有奖励均为不可转让的卡牌碎片（仅游戏内使用）。PAXI 消费均为明码标价、确定获得，无任何随机赔付。',
      'help_kv_compliance': '合规状态',
      'help_kv_compliance_v': '✅ 已开启（不收不付 TKCC）',
      'help_kv_drawlimit': '每日免费抽卡次数',
      'help_kv_fragcap': '每日碎片获取上限',
      'help_free': '免费',
      'help_cost': '消耗',
      'help_reward': '奖励',
      'help_fragments': '卡牌碎片',
      'help_seasonpts': '赛季点数',
      'help_stamina': '体力',
      'help_draw_title': '免费抽卡',
      'help_draw_desc': '每天可免费抽卡获得武将卡。卡牌分四个稀有度：普通 / 稀有 / 史诗 / 传说，稀有度越高战力越强。',
      'help_draw_cost': '费用',
      'help_draw_pack3': '三连抽',
      'help_draw_pack3_v': '一次消耗 3 次额度、获得 3 张卡',
      'help_stage_title': '关卡推图',
      'help_stage_desc': '编选武将出战，通过关卡获得碎片奖励。每个关卡只能首次通关领取，通关记录防重复。',
      'help_ranked_title': '天梯排位',
      'help_ranked_desc': '派出 9 张卡（3 组 × 3 张）与同段位 AI 进行 9v9 对决，全程确定性计算、无随机数——胜负完全由你的阵容决定。',
      'help_ranked_rules': '段位规则',
      'help_ranked_rules_v': '胜 +20 分 / 负 -10 分；满 100 分升一段、归零降一段，共 5 段，段位越高奖励越多',
      'help_daily_title': '每日任务（4 项）',
      'help_daily_desc': '每天完成下列行为后可各领取一次奖励（碎片 + 赛季点），UTC 时间 0 点重置：',
      'help_daily_t0': '通关任意 1 个关卡',
      'help_daily_t1': '天梯对局获胜 1 场',
      'help_daily_t2': '购买 1 张卡牌',
      'help_daily_t3': '购买 1 包碎片',
      'help_shop_title': '商店（PAXI 消费）',
      'help_shop_desc': '所有商品明码标价、付款即得。价格为链上配置，以下为默认价：',
      'help_shop_card': '武将卡（普/稀/史/传）',
      'help_shop_frag': '碎片包 ×10（普/稀/史/传）',
      'help_shop_stamina': '体力包（+30 体力）',
      'help_shop_stamina_v': '/ 包',
      'help_shop_skin': '皮肤',
      'help_shop_skin_v': '管理员定价，纯外观、永久拥有',
      'help_shop_season': '赛季通行证',
      'help_shop_season_v': '管理员定价，按赛季点逐层领碎片',
      'help_shop_note': '💡 提示',
      'help_shop_note_v': '直接买卡比碎片合成便宜，碎片适合补缺或加速特定卡',
      'help_stamina_title': '体力系统',
      'help_stamina_desc': '上限 120 点，每 5 分钟自动恢复 1 点。关卡与天梯消耗体力；体力不足时可用 2 PAXI/包购买（每包 +30），满体力时无法购买。',
      'help_cult_title': '卡牌养成（碎片消耗）',
      'help_cult_desc': '四个稀有度（普通/稀有/史诗/传说）对应消耗如下：',
      'help_cult_star': '升星（1★→5★）',
      'help_cult_craft': '碎片合成新卡',
      'help_cult_decompose': '分解回收（得碎片）',
      'help_prop_title': '提案治理（新卡投票）',
      'help_prop_desc': '任何人可提交新卡牌模板提案，全社区投票。投票期结束后执行：通过 → 新卡入池并退还押金；未通过 → 押金没收归入庄家。',
      'help_prop_deposit': '提案押金',
      'help_prop_vote': '投票权',
      'help_prop_vote_v': '按合约内 TKCC 余额计算（1 TKCC = 1 票），只读不扣，不投票不消耗',
      'help_safety_title': '安全须知',
      'help_safety_desc': '游戏使用「无感签名」：会话密钥只授权游戏操作、有每日限额、随时可在设置中撤销，主钱包私钥绝不离开你的设备。',
      'help_safety_frag': '碎片属性',
      'help_safety_frag_v': '不可转让、不可交易，仅限本人游戏内使用',
      'help_safety_session': '会话安全',
      'help_safety_session_v': '每日消费限额 + nonce 防重放 + 地址绑定，泄露可一键撤销',
      'shop_season_desc': '购买通行证后，按赛季点数逐层领取碎片奖励（仅碎片，合规安全）。',
      'shop_season_pass_price': '通行证价格',
      'shop_season_buy': '购买通行证',
      'shop_season_owned': '✅ 已拥有通行证',
      'shop_season_points': '赛季点数',
      'shop_season_tier_claim': '领取',
      'shop_season_tier_claimed': '✅ 已领取',
      'shop_season_tier_locked': '🔒 点数不足',
      'shop_season_inactive': '⚠️ 赛季未开启（等待运营配置）',
      'ranked_title': '🏅 天梯排位',
      'ranked_desc': '消耗 10 体力挑战同段位 AI（确定性 9v9 复算，零随机），胜利得碎片 + 赛季点，连胜升段。',
      'ranked_tier': '当前段位',
      'ranked_points': '当前积分',
      'ranked_cost': '体力消耗',
      'ranked_pick': '出战编队（9 张）',
      'ranked_need9': '需要 9 张卡',
      'ranked_start': '挑战天梯',
      'ranked_won': '天梯胜利！获得 {n} 个碎片',
      'ranked_lose': '天梯失败，积分 -10',
      'ranked_ok': '天梯结算完成',
      'dailytask_title': '📅 每日任务',
      'dailytask_desc': '完成任务领取碎片 + 赛季点，每日每任务一次（按 UTC 日 0 点重置）。',
      'dailytask_claim': '领取',
      'dailytask_progress': '进度',
      'dailytask_reward': '奖励',
      'dailytask_claimed': '✅ 已领取',
      'dailytask_incomplete': '未完成',
      'dtask_0': '通关 1 个关卡',
      'dtask_1': '天梯胜利 1 场',
      'dtask_2': '购买 1 张卡牌',
      'dtask_3': '购买 1 包碎片',
    },
    en: {
      'sg_title': '🀄 Sanguo 2.0',
      'sg_subtitle': 'Spend PAXI + TKCC to draw general cards — yours forever.',
      'tab_draw': '🎴 Draw',
      'tab_mycards': '🃏 My Cards',
      'draw_single': '🗡️ Single',
      'draw_pack3': '🎴 Triple',
      'draw_single_title': '🗡️ Single Draw (1 card)',
      'draw_pack3_title': '🎴 Triple Draw (3 cards)',
      'cost_label': 'Cost',
      'bal_title': '💰 Balance',
      'bal_tkcc': 'In-contract TKCC',
      'loading': 'Loading…',
      'my_cards': 'My Cards',
      'my_cards_desc': 'All your general cards, stored permanently.',
      'empty_cards': 'Tap "Draw" to get cards',
      'power_label': 'Power',
      'insufficient': 'Insufficient balance, deposit TKCC first',
      'connect_first': 'Please connect your wallet first',
      'params_err': 'Failed to read Sanguo contract params. Check the contract address and network, then retry.',
      'draw_doing': 'Drawing…',
      'draw_ok': 'Success! New cards added',
      'draw_ok_short': 'Draw succeeded!',
      'draw_fail': 'Draw failed: ',
      'register_session': 'Registering session…',
      'back_home': '← Game Hub',
      'contract_missing': 'Set the contract address in "My Account" first',
      // ---- 第七轮恢复：完整玩法页签 ----
      'tab_ai': 'AI Battle',
      'tab_cultivate': 'Cultivate',
      'tab_proposal': 'Proposal',
      'tab_pvp': 'PVP',
      'tab_royale': 'Royale',
      'tab_ledger': '📊 Ledger',
      // ---- 🎁 Gift system ----
      'tab_gift': '🎁 Gift',
      'gift_title': '🎁 Gift to Friend',
      'gift_desc': 'Send cards / fragments / skins to a friend you battled with and known for 30+ days.',
      'gift_to': 'Recipient address',
      'gift_to_ph': "friend's paxi1... wallet",
      'gift_kind': 'Gift type',
      'gift_kind_card': 'Card',
      'gift_kind_frag': 'Fragment',
      'gift_kind_skin': 'Skin',
      'gift_card': 'Select card',
      'gift_rarity': 'Rarity',
      'gift_amount': 'Amount',
      'gift_skin': 'Select skin',
      'gift_send': 'Send gift',
      'gift_status': 'My gift status',
      'gift_acct_age': 'Account age',
      'gift_pair_ok': 'Pair ok',
      'gift_sent_today': 'Sent today',
      'gift_recv_today': 'Received today',
      'gift_hold': 'Holding(normal/legend)',
      'gift_select_to': 'Enter recipient address',
      'gift_invalid_addr': 'Invalid address (must start with paxi1)',
      'gift_no_card': 'No card to gift',
      'gift_no_skin': 'No skin to gift',
      'gift_amount_err': 'Enter a valid fragment amount',
      'gift_ok': 'Gift sent!',
      'gift_fail': 'Gift failed: ',
      'gift_status_err': 'Cannot read gift status',
      'gift_rules': 'Rules: account≥30d · pair≥30d · holding 30d (legend 7d) · ≤3 send / ≤5 recv per day · ≤30 frags per gift',

      // ---- Compliance: shop / stages / free draw ----
      'tab_shop': '🛒 Shop',
      'tab_stage': '🗺️ Stages',
      'draw_free_title': '🎴 Free Draw',
      'draw_free_desc': 'Compliance edition: drawing is completely free — no PAXI / TKCC consumed.',
      'draw_remaining': 'Draws left today',
      'draw_free_done': 'Daily free draws used up — come back tomorrow!',
      'draw_not_migrated': '⚠️ The contract has not been migrated to the compliance edition (v0.1.1) yet, so free draw is unavailable. The UI below is a preview of the compliance edition; it will auto-enable once the contract is migrated.',
      'shop_title': '🛒 Hero Shop',
      'shop_desc': 'Fixed prices, pay and get (deterministic purchase — no randomness, no payouts).',
      'shop_cards': 'Buy cards directly (1★ Lv0)',
      'shop_frags': 'Fragment packs ({n} per pack)',
      'shop_buy': 'Buy',
      'shop_packs': 'Packs to buy',
      'shop_buying': 'Purchasing…',
      'shop_ok': 'Purchase succeeded!',
      'shop_fail': 'Purchase failed: ',
      'shop_price_na': 'Price not configured',
      'shop_frag_ok': 'Got {n} {r} fragments!',
      'shop_card_ok': 'Purchased "{name}"!',
      'stage_title': '🗺️ Stage Challenge',
      'stage_desc': 'Form 9 cards (3 groups of 3) to challenge stages. Recomputed on-chain; fragments on clear.',
      'stage_pick': 'Battle formation (9 cards; order forms groups 1-3 / 4-6 / 7-9)',
      'stage_need9': 'Need 9 cards',
      'stage_submit': 'Challenge',
      'stage_submitting': 'Settling battle…',
      'stage_ok': 'Stage cleared! Reward fragments added.',
      'stage_fail': 'Challenge failed: ',
      'stage_cleared_already': 'Stage already cleared',
      'stage_no_stages': 'No stages yet (awaiting operator config)',
      'stage_reward': 'Clear reward',
      'stage_wins': 'Group score',
      'order_max9': 'Up to 9 cards (3 groups × 3)',
      'ai_title': 'AI Battle',
      'ai_desc': 'Pick a difficulty and battle the AI; free entry, win fragments',
      'ai_diff': 'Difficulty',
      'ai_fee': 'Entry fee',
      'ai_reward': 'Win reward',
      'win_frag': 'Win fragments',
      'free_entry_ok': 'Free entry — fragments rewarded',
      'claim_frag': 'Claimed fragments: {frag}',
      'ai_pending_hint': 'You won {n} battles — tap below to claim to your wallet.',
      'ai_stats': 'Battles today',
      'cult_title': 'Cultivate',
      'cult_desc': 'Star up / Decompose / Upgrade / Craft / Battle order',
      'frag_title': 'Fragments',
      'rarity_common': 'Common',
      'rarity_rare': 'Rare',
      'rarity_epic': 'Epic',
      'rarity_legend': 'Legend',
      'order_title': 'Battle order',
      'set_order_btn': 'Set order',
      'starup_btn': 'Star up',
      'decompose_btn': 'Decompose',
      'upgrade_btn': 'Upgrade',
      'decompose_confirm': 'Decompose this card?\nThe card will be converted into fragments. This cannot be undone!',
      'select_rarity': 'Select Rarity',
      'craft_btn': 'Craft',
      'craft_desc': 'Spend fragments of a rarity to get a random card of that rarity.',
      'craft_common': '🟤 Craft Common ({cost} frags)',
      'craft_rare': '🔵 Craft Rare ({cost} frags)',
      'craft_epic': '🟣 Craft Epic ({cost} frags)',
      'craft_legend': '🟡 Craft Legend ({cost} frags)',
      'craft_insufficient': 'Not enough fragments: need {need}, you have {have}',
      'select_card_first': 'Select a card first',
      'prop_title': 'Card Proposals',
      'prop_desc': 'Submit a new general card; on-chain after community vote',
      'prop_propose': 'Propose new card',
      'prop_name': 'Card name',
      'prop_attack': 'Attack',
      'prop_defense': 'Defense',
      'prop_weight': 'Weight',
      'prop_submit': 'Submit proposal',
      'prop_list': 'Proposal list',
      'prop_votes': 'Votes',
      'prop_approved': 'Approved',
      'prop_rejected': 'Rejected',
      'prop_open': 'Voting',
      'prop_vote_yes': 'Yes',
      'prop_vote_no': 'No',
      'prop_execute': 'Execute',
      'prop_cancel': 'Cancel',
      'pvp_title': 'PVP 1v1',
      'pvp_desc': '1v1 battle with a friend — free entry, win fragments',
      'pvp_create': 'Create match',
      'pvp_opponent': 'Opponent address',
      'pvp_public': 'Public match',
      'pvp_list': 'Match list',
      'pvp_accept': 'Accept',
      'pvp_cancel': 'Cancel',
      'pvp_claim': 'Claim',
      'royale_title': 'Royale',
      'royale_desc': '4-6 player brawl — free entry, win fragments',
      'royale_create': 'Create royale',
      'royale_size': 'Size',
      'royale_join': 'Join',
      'royale_settle': 'Settle',
      'royale_claim': 'Claim',
      'royale_list': 'Royale list',
      'pending_reward': 'Pending rewards',
      'claim_btn': 'Claim',
      'doing': 'Processing…',
      'ok_short': 'Success',
      'fail_prefix': 'Failed: ',
      'need_connect': 'Connect wallet and select a card first',
      // ---- 第七轮恢复：补充文案 ----
      'ai_today': 'Battles today',
      'ai_limit': 'Daily limit',
      'win_rate': 'Win rate',
      'order_max': 'Up to 9 cards in battle order (3 groups × 3)',
      'selected_label': 'Selected',
      'prop_id': 'Card ID',
      'prop_status': 'Status',
      'prop_yes': 'Yes votes',
      'prop_no': 'No votes',
      'prop_deadline': 'Deadline',
      'deposit_label': 'Deposit',
      'none_label': 'None',
      'match_id_label': 'Match',
      'status_label': 'Status',
      'opponent_label': 'Opponent',
      'winner_label': 'Winner',
      'reward_label': 'Reward',
      'pick_title': 'Select cards',
      'create_ok': 'Created',
      'accept_ok': 'Accepted',
      'join_ok': 'Joined',
      'settle_ok': 'Settled',
      'execute_ok': 'Executed',
      'cancel_ok': 'Cancelled',
      'propose_ok': 'Proposal submitted',
      'vote_ok': 'Voted',
      'claim_ok': 'Claimed',
      // ---- Payout / spend amount tips (parsed from the tx itself) ----
      'claim_in': '✅ Received {amt} TKCC',
      'claim_in_burn': '✅ Received {amt} TKCC (contract burned {burned} TKCC)',
      'spent_tip': '✅ {what} · spent {amt} TKCC (from in-contract balance)',
      'need_three': 'Select 3 cards first',
      'need_nine': 'Select 9 cards first',
      'pick_limit': 'Select {n} cards first',
      'team_cost_over': 'Team cost over cap: {total} > {cap}, swap some cards and retry',
      'tab_battleparams': 'Battle Params',
      'bp_title': 'Battle Coefficient Tuning',
      'bp_desc': 'Admin only: save applies all values on-chain instantly (0 = fallback to default). Skill/Bond strength are global multipliers: 10000 = 100%, max 30000 (3x). Faction chain wei→shu→wu→qun→wei; troop chain cavalry→archer→strategist→guard→cavalry.',
      'bp_default': 'default',
      'bp_json_title': 'Full params JSON (advanced)',
      'bp_json_hint': 'Form edits sync into JSON automatically; you may also edit directly. Deprecated fee fields are force-zeroed server-side.',
      'bp_save': 'Save params on-chain',
      'bp_save_ok': 'Battle params updated',
      'bp_invalid_json': 'Invalid JSON, please check and retry',
      'bp_faction_counter_bp': 'Faction counter bonus',
      'bp_faction_countered_bp': 'Faction countered penalty',
      'bp_faction_neutral_bp': 'Faction neutral',
      'bp_troop_counter_bp': 'Troop counter bonus',
      'bp_troop_countered_bp': 'Troop countered (no penalty by default)',
      'bp_troop_neutral_bp': 'Troop neutral',
      'bp_rarity_legend_bp': 'Legend coefficient',
      'bp_rarity_epic_bp': 'Epic coefficient',
      'bp_rarity_rare_bp': 'Rare coefficient',
      'bp_rarity_common_bp': 'Common coefficient',
      'bp_power_flat_cap_bp': 'Power flat cap',
      'bp_eff_lower_bound_bp': 'Debuff lower bound',
      'bp_skill_strength_bp': 'Skill strength (global)',
      'bp_bond_strength_bp': 'Bond strength (global)',
      'troop_cavalry': 'Cavalry',
      'troop_archer': 'Archer',
      'troop_strategist': 'Strategist',
      'troop_guard': 'Guard',
      'skill_locked': 'Skill "{name}" (unlocks at 3★)',
      'bond_label': 'Bonds',
      'bond_active': '{name} +{bp}% ({cnt}/{need} cards)',
      'help_battle_title': 'Battle Rules (9v9, 3 groups)',
      'help_battle_desc': 'No randomness: the on-chain engine resolves deterministically. Power = (ATK+DEF) × (1+flat) × faction × troop × bond × rarity.',
      'help_faction_chain': 'Faction counters',
      'help_faction_chain_v': 'wei→shu→wu→qun→wei (+15% / −10%)',
      'help_troop_chain': 'Troop counters',
      'help_troop_chain_v': 'cavalry→archer→strategist→guard→cavalry (+10% / no penalty)',
      'help_skill_rule': 'Skills',
      'help_skill_rule_v': 'Unlock at 3★; triggers: battle start / group start / won group / lost group / lower power / higher power',
      'help_bond_rule': 'Bonds',
      'help_bond_rule_v': 'Activate by team member count; only the single highest tier applies (e.g. Five Tiger Generals: 3 cards +8%, 5 cards +18%)',
      'help_mystats_title': 'My Record',
      'help_mystats_desc': 'Accumulated on-chain per wallet address — survives device changes. Format: battles / wins.',
      'help_mystats_all': 'Total (all modes)',
      'help_mystats_ai': 'AI battles (casual + ranked)',
      'help_mystats_pvp': 'PVP 1v1',
      'help_mystats_royale': 'Royale',
      'help_mystats_stage': 'Stages (clears only)',
      'help_coeff': 'Current coefficients (on-chain params)',
      'help_coeff_hint': '0 falls back to defaults; admins can tune in "Battle Params"',
      'battle_group': 'Group {n}',
      'group_win': 'Win',
      'group_lose': 'Lose',
      'group_draw': 'Draw',

      // ---- Old contract migration ----
      'migrate_title': 'Old contract migration',
      'migrate_desc': 'Move your cards (rarity/ATK/DEF/star/level preserved) and fragments from the old Three-Kingdoms contract in one shot. Once per wallet.',
      'migrate_btn': 'Migrate now',
      'migrate_doing': 'Migrating…',
      'migrate_ok': 'Migration complete',
      'migrate_done': 'This wallet has already migrated',
      'migrate_opening': 'Migration not opened yet',
      'migrate_none': 'No cards or fragments to migrate',
      // ---- Migration cap (gas budget) ----
      'migrate_limit_note': '⚠️ Max 30 cards per migration (gas budget cap). If you hold more than 30 cards on the old contract, decompose the extra ones there first, then come back. One migration per wallet — a failed migration does not use up that chance.',
      'migrate_over_limit': 'You have {n} cards on the old contract, over the {max}-card limit. Please decompose {over} of them first (this hint refreshes automatically afterwards).',
      'migrate_gas_hint': 'Gas limit set to {gas} for {n} cards (the declared fee is charged in full; unused gas is NOT refunded).',
      'migrate_no_preview': '(Could not read old-contract card count; gas prepared for the {max}-card cap.)',
      'migrate_blocked': 'Card count over the limit — decompose first, then migrate',
      'migrate_old_summary': 'Old contract: {n} cards · fragments (C/R/E/L) {fg}',
      'migrate_ok_detail': '✅ {msg}: {minted} cards, {frags} fragments{skipped}',
      'migrate_ok_skip': ' (skipped {n})',

      // ---- stat cards / codex ----
      'sg_stat_wins': 'Wins', 'sg_stat_cards': 'Cards', 'sg_stat_battles': 'Battles', 'sg_stat_frag': 'Fragments',
      'codex_open': '📚 Card Codex ({n} generals)',
      'codex_progress': 'Collecting: {own} / {total} (tap a card for details)',
      'codex_not_owned': 'Not owned',
      'codex_search': 'Search name / title',
      'codex_collect': 'Collected',
      'codex_empty': 'No matching cards',
      'sort_power': 'By Power',
      'sort_atk': 'By ATK',
      'sort_def': 'By DEF',
      'sort_name': 'By Name',
      'batch_decompose': 'Batch Decompose',
      'batch_decompose_do': 'Decompose Selected',
      'batch_none': 'Select cards to decompose first',
      'batch_decompose_confirm': 'Decompose {n} cards?\nCards are destroyed permanently and fragments returned. Cannot be undone!',
      'batch_decompose_ok': 'Decomposed {n} cards',
      'selected': 'Selected',
      'cancel': 'Cancel',

      // ---- card detail ----
      'detail_title_wrap': '"{t}"',
      'detail_stats': '{identity}{title}  ATK {atk} · DEF {def} · Power {pow}',

      // ---- AI lineup picker ----
      'ai_my_cards': 'My Cards',
      'ai_pick_title': '🃏 Pick battle cards',
      'ai_pick_desc': 'Pick up to 3 cards; the order is the play order (first card goes first). Leave empty to keep your current lineup.',
      'ai_need_three_btn': 'Need at least 3 cards',
      'ai_need_three_hint': '❌ AI battle needs at least 3 cards. Draw cards first, then come back.',
      'ai_need_three_msg': 'AI battle needs at least 3 cards. Draw cards first, then come back.',
      'order_saved': 'Play order: {names}',

      // ---- battle arena ----
      'battle_result_title': '⚔️ Battle Result',
      'battle_win': '🏆 Victory!', 'battle_lose': '💀 Defeat', 'battle_draw': '🤝 Draw',
      'battle_you': 'You', 'battle_opp': 'Opponent',
      'battle_deployed': ' (deployed)',
      'battle_reward': 'Reward: {amt} TKCC',
      'battle_frag_reward': 'Fragments won: {frag}',
      'battle_rounds': '{n} round wins',
      'battle_challenger': 'Challenger', 'battle_defender': 'Defender',
      'battle_ai_general': 'AI General', 'battle_ai_diff': 'AI Lv.{n}',

      // ---- skill trigger replay (V2.1: on-chain skill_log event) ----
      'skill_log_title': '🎯 Skill Trigger Log',
      'skill_log_empty': 'No skills triggered this battle',
      'skill_log_side_a': 'Side A', 'skill_log_side_b': 'Side B',
      'skill_log_team_wide': 'Team-wide',
      'trg_on_battle_start': 'Battle Start', 'trg_on_group_start': 'Group Start',
      'trg_on_win_group': 'Won Group', 'trg_on_lose_group': 'Lost Group',
      'trg_on_low_power': 'Low Power', 'trg_on_high_power': 'High Power',
      'tgt_self': 'Self', 'tgt_opponent': 'Opponent',

      // ---- draw: insufficient PAXI ----
      'draw_mode_single': 'Single draw', 'draw_mode_pack3': 'Triple draw',
      'draw_paxi_lack': 'Insufficient in-contract PAXI: {mode} needs {need} PAXI, you have {have} PAXI. Deposit at least {lack} PAXI first.',

      // ---- star-up / level-up / decompose ----
      'err_card_notfound': 'Card not found. Refresh "My Cards" and retry.',
      'err_max_star': '⭐ This card is already at max stars (5★).',
      'err_bal_query': 'Failed to read in-contract balance. Please try again later.',
      'err_tkcc_star': 'Insufficient in-contract TKCC: {from}★→{to}★ needs {need} TKCC, you have {have} TKCC. Deposit in "Wallet" first.',
      'confirm_star_up': 'Star-up {from}★ → {to}★\n\nCost: {fee} TKCC (deducted from in-contract balance)\nof which burn {half} + bankroll {half}\n\nOK = star up, Cancel = abort',
      'err_frag_star': 'Not enough fragments: fragment star-up needs {need} {rarity} fragments, you have {have} (no TKCC required).',
      'confirm_star_frag': 'Fragment star-up {from}★ → {to}★\n\nConsumes {need} {rarity} fragments (no TKCC, no burn)\nYou have {have}\n\nOK = star up, Cancel = abort',
      'err_max_level': '💠 This card is already at max level (Lv10).',
      'err_frag_level': 'Not enough fragments: level-up Lv{from}→Lv{to} needs {need} {rarity} fragments, you have {have}.',
      'err_sig_format': 'Session signature error (signature is empty) — usually the browser cached an old script. Hard-refresh the page (or clear cache) and retry.',
      'confirm_level_up': 'Level-up Lv{from} → Lv{to}\n\nConsumes {need} {rarity} fragments\nGain: ATK +3 · DEF +2 (Power +5)\nYou have {have}\n\nOK = level up, Cancel = abort',
      'confirm_decompose': '⚠️ Decomposing permanently destroys this card!\n\n"{name}" {star}★ Lv{lv}\nOnly {back} {rarity} fragments are returned\n(stars/levels/fees already invested are not refunded — decomposing an upgraded card wastes them)\n\nOK = decompose, Cancel = keep',

      // ---- admin ledger page ----
      'ledger_loading': 'Loading…',
      'ledger_scanning': '⏳ Parsing on-chain draw events one by one…',
      'ledger_rpc_limited': '⚠️ Per-tx stats need RPC access, which is restricted here (e.g. inside a mobile wallet). Open this page in a desktop browser to see per-tx receipts.',
      'ledger_scan_ok': '✅ All draw transactions parsed per-tx (on-chain is authoritative).',
      'ledger_scan_fail': '⚠️ Per-tx parsing unavailable; the "received" columns show — .',
      'ledger_th_addr': 'Fee address', 'ledger_th_count': 'Txs', 'ledger_th_paxi': 'PAXI received', 'ledger_th_tkcc': 'TKCC received',
      'ledger_total': 'Total',
      'ledger_total_burn': 'Total TKCC burned by game contract',
      'ledger_burn_desc': 'Burn is a real burn (tokens permanently destroyed), reaching no wallet; matches the 40% TKCC portion of each draw.',
      'ledger_wallet_note': 'Note: wallets/Ping.pub mis-parse PRC-20 wasm transfer events (often labeling 10 PAXI as 10 TKCC, or hiding the 120,000 TKCC). This page reads on-chain events directly, so the numbers match the chain.',
      'ledger_done': '✅ Done, {n} fee addresses',
      'ledger_admin_only': '⛔ This page is admin-only.',
      'ledger_title': '📊 Revenue reconciliation (admin)',
      'ledger_desc': 'Parses draw wasm events per-tx across {n} fee addresses, showing the real PAXI + TKCC received (on-chain is authoritative, unaffected by wallet display). Includes cumulative burn of the game contract.',
      'ledger_refresh': '🔄 Refresh',
      'ledger_hint_click': 'Tap "Refresh" to start loading…',

      // ---- 🆕 New: Ranked / Skins / Season Pass / Stamina / Daily Tasks ----
      'tab_ranked': '🏅 Ranked',
      'tab_dailytask': '📅 Daily',
      'shop_stamina': 'Stamina',
      'shop_stamina_desc': 'Auto-recovers 1 per 5 min (max 120); buy to refill instantly.',
      'shop_stamina_now': 'Current',
      'shop_stamina_max': 'Max',
      'shop_stamina_buy': 'Buy Stamina',
      'shop_stamina_pack': '+30 per pack',
      'shop_skins': 'Skins (cosmetic)',
      'shop_skins_desc': 'Buy with PAXI; cosmetic only, non-transferable, owned forever.',
      'shop_skin_owned': '✅ Owned',
      'shop_skin_buy': 'Buy',
      'shop_season': 'Season Pass',
      'compliance_disabled': '🛡️ This battle mode is temporarily unavailable. Compliance AI/PVP/Royale are free entry + fragment rewards.',
      'tab_help': 'Guide',
      'help_title': 'Sanguo 2.0 · Game Guide',
      'help_intro': 'This game runs in compliance mode: no TKCC is used at any point; all rewards are non-transferable card fragments (in-game only). All PAXI spending is fixed-price and deterministic — no random payouts.',
      'help_kv_compliance': 'Compliance',
      'help_kv_compliance_v': '✅ Active (no TKCC in or out)',
      'help_kv_drawlimit': 'Daily free draws',
      'help_kv_fragcap': 'Daily fragment cap',
      'help_free': 'Free',
      'help_cost': 'Cost',
      'help_reward': 'Rewards',
      'help_fragments': 'Card fragments',
      'help_seasonpts': 'Season points',
      'help_stamina': 'Stamina',
      'help_draw_title': 'Free Draws',
      'help_draw_desc': 'Draw hero cards for free every day. Four rarities: Common / Rare / Epic / Legendary — higher rarity means stronger cards.',
      'help_draw_cost': 'Fee',
      'help_draw_pack3': 'Triple draw',
      'help_draw_pack3_v': 'Uses 3 daily draws, grants 3 cards',
      'help_stage_title': 'Stage Campaign',
      'help_stage_desc': 'Send your heroes into stages to earn fragments. Each stage pays out on first clear only; anti-replay keeps records unique.',
      'help_ranked_title': 'Ranked Battles',
      'help_ranked_desc': 'Field 9 cards (3 groups × 3) against tier-matched AI in deterministic 9v9 combat — zero randomness, the outcome depends entirely on your lineup.',
      'help_ranked_rules': 'Rank rules',
      'help_ranked_rules_v': 'Win +20 / loss -10; promote at 100 pts, demote at 0, 5 tiers total — higher tiers pay more',
      'help_daily_title': 'Daily Tasks (4)',
      'help_daily_desc': 'Complete the actions below each day and claim once per task (fragments + season points). Resets at 00:00 UTC:',
      'help_daily_t0': 'Clear any 1 stage',
      'help_daily_t1': 'Win 1 ranked battle',
      'help_daily_t2': 'Buy 1 card',
      'help_daily_t3': 'Buy 1 fragment pack',
      'help_shop_title': 'Shop (PAXI)',
      'help_shop_desc': 'Everything is fixed-price and granted instantly. Prices are configured on-chain; defaults shown:',
      'help_shop_card': 'Hero cards (C/R/E/L)',
      'help_shop_frag': 'Fragment packs ×10 (C/R/E/L)',
      'help_shop_stamina': 'Stamina pack (+30)',
      'help_shop_stamina_v': 'per pack',
      'help_shop_skin': 'Skins',
      'help_shop_skin_v': 'Operator-priced, cosmetic only, owned forever',
      'help_shop_season': 'Season Pass',
      'help_shop_season_v': 'Operator-priced, claim fragments tier by tier with season points',
      'help_shop_note': '💡 Tip',
      'help_shop_note_v': 'Buying cards directly is cheaper than crafting; fragments suit gap-filling or targeting a specific card',
      'help_stamina_title': 'Stamina System',
      'help_stamina_desc': 'Max 120, regenerates 1 point every 5 minutes. Stages and ranked battles consume stamina. When short, buy packs at 2 PAXI each (+30); cannot buy at full stamina.',
      'help_cult_title': 'Card Cultivation (fragments)',
      'help_cult_desc': 'Fragment costs by rarity (Common / Rare / Epic / Legendary):',
      'help_cult_star': 'Star-up (1★→5★)',
      'help_cult_craft': 'Craft new card',
      'help_cult_decompose': 'Decompose (refund)',
      'help_prop_title': 'Governance (card proposals)',
      'help_prop_desc': 'Anyone may submit a new card template proposal for community voting. After the voting period: approved → card enters the pool and deposit refunded; rejected → deposit forfeited to the house.',
      'help_prop_deposit': 'Proposal deposit',
      'help_prop_vote': 'Voting power',
      'help_prop_vote_v': 'Based on in-contract TKCC balance (1 TKCC = 1 vote), read-only — voting never spends tokens',
      'help_safety_title': 'Safety Notes',
      'help_safety_desc': 'The game uses seamless signing: session keys only authorize game actions, carry daily limits, and can be revoked anytime in settings. Your main wallet private key never leaves your device.',
      'help_safety_frag': 'Fragments',
      'help_safety_frag_v': 'Non-transferable, non-tradeable, personal in-game use only',
      'help_safety_session': 'Session security',
      'help_safety_session_v': 'Daily spend limit + nonce anti-replay + address binding; revoke instantly if leaked',
      'shop_season_desc': 'After buying the pass, claim fragment rewards by tier using season points (fragments only).',
      'shop_season_pass_price': 'Pass price',
      'shop_season_buy': 'Buy Pass',
      'shop_season_owned': '✅ Pass owned',
      'shop_season_points': 'Season points',
      'shop_season_tier_claim': 'Claim',
      'shop_season_tier_claimed': '✅ Claimed',
      'shop_season_tier_locked': '🔒 Not enough points',
      'shop_season_inactive': '⚠️ Season not active (awaiting operator config)',
      'ranked_title': '🏅 Ranked',
      'ranked_desc': 'Spend 10 stamina to fight same-tier AI (deterministic 9v9, zero randomness). Win → fragments + season points; win streaks promote tier.',
      'ranked_tier': 'Tier',
      'ranked_points': 'Points',
      'ranked_cost': 'Stamina cost',
      'ranked_pick': 'Lineup (9 cards)',
      'ranked_need9': 'Need 9 cards',
      'ranked_start': 'Ranked Battle',
      'ranked_won': 'Ranked win! Got {n} fragments',
      'ranked_lose': 'Ranked loss, -10 points',
      'ranked_ok': 'Ranked settled',
      'dailytask_title': '📅 Daily Tasks',
      'dailytask_desc': 'Complete tasks for fragments + season points; once per task per day (resets at UTC 0:00).',
      'dailytask_claim': 'Claim',
      'dailytask_progress': 'Progress',
      'dailytask_reward': 'Reward',
      'dailytask_claimed': '✅ Claimed',
      'dailytask_incomplete': 'Incomplete',
      'dtask_0': 'Clear 1 stage',
      'dtask_1': 'Win 1 ranked battle',
      'dtask_2': 'Buy 1 card',
      'dtask_3': 'Buy 1 fragment pack',
    },
  };
  function t(k) {
    const l = (window.HUB_LANG === 'en') ? 'en' : 'zh';
    return (i18n[l] && i18n[l][k] != null) ? i18n[l][k] : (i18n.zh[k] != null ? i18n.zh[k] : k);
  }
  /** 带占位的文案：tf('migrate_over_limit', { n: 40, max: 30, over: 10 }) */
  function tf(k, vars) {
    return String(t(k)).replace(/\{(\w+)\}/g, (_, key) => (vars && vars[key] != null ? vars[key] : `{${key}}`));
  }

  // ============================================================
  // 工具
  // ============================================================
  function getCardImage(name) {
    // 全部卡牌统一按名字取本地托管图（assets/cards/<名字>.webp）
    return (CARD_IMAGE_BASE + name + '.webp');
  }
  // 皮肤图片（按 skin_id 命名，部署到仓库 assets/skins/）
  const SKIN_IMAGE_BASE = 'https://moxiaomo856.github.io/paxi-card-game/assets/skins/';
  function getSkinImage(id) {
    return (SKIN_IMAGE_BASE + id + '.png');
  }

  // ============================================================
  // 链上卡牌模板（P1-8：图鉴优先读链上 sanguo_templates，失败回退本地硬编码）
  // ============================================================
  let _sgTemplatesCache = null;   // 链上模板缓存
  let SG_TPL_COUNT = CARD_TEMPLATES.length;   // 图鉴入口计数（链上加载后动态更新）

  // 新增 30 张卡（31-60）的称号/阵营兜底（链上 CardTemplate 只存 id/name/rarity/attack/defense/weight，
  // 不带 title/identity 展示字段；图鉴与详情按名字查此表补齐）
  const SG_NEW_META = {
    '刘备': { title: '昭烈帝', identity: '蜀·昭烈帝' },
    '孙权': { title: '吴大帝', identity: '吴·吴大帝' },
    '孙坚': { title: '武烈皇帝', identity: '吴·武烈皇帝' },
    '董卓': { title: '太师', identity: '群·太师' },
    '郭嘉': { title: '鬼才', identity: '魏·鬼才' },
    '许褚': { title: '虎痴', identity: '魏·虎痴' },
    '张郃': { title: '巧变', identity: '魏·巧变' },
    '黄盖': { title: '苦肉', identity: '吴·苦肉' },
    '孙尚香': { title: '弓腰姬', identity: '吴·弓腰姬' },
    '马岱': { title: '临危', identity: '蜀·临危' },
    '华佗': { title: '神医', identity: '群·神医' },
    '颜良': { title: '河北庭柱', identity: '群·河北庭柱' },
    '荀彧': { title: '王佐', identity: '魏·王佐' },
    '甄姬': { title: '洛神', identity: '魏·洛神' },
    '大乔': { title: '国色', identity: '吴·国色' },
    '小乔': { title: '天香', identity: '吴·天香' },
    '周泰': { title: '幼平', identity: '吴·幼平' },
    '黄月英': { title: '机关', identity: '蜀·机关' },
    '关兴': { title: '安国', identity: '蜀·安国' },
    '张苞': { title: '虎嗣', identity: '蜀·虎嗣' },
    '陈宫': { title: '公台', identity: '群·公台' },
    '貂蝉': { title: '闭月', identity: '群·闭月' },
    '曹洪': { title: '骠骑', identity: '魏·骠骑' },
    '许攸': { title: '谋乱', identity: '魏·谋乱' },
    '张昭': { title: '文侯', identity: '吴·文侯' },
    '朱然': { title: '义封', identity: '吴·义封' },
    '关平': { title: '坦之', identity: '蜀·坦之' },
    '周仓': { title: '山贼', identity: '蜀·山贼' },
    '田丰': { title: '元皓', identity: '群·元皓' },
    '审配': { title: '正南', identity: '群·正南' },
  };
  async function loadSanguoTemplates(force) {
    if (_sgTemplatesCache && !force) return _sgTemplatesCache;
    try {
      const r = await queryContract({ sanguo_templates: { start_after: null, limit: 200 } });
      const arr = (r && Array.isArray(r.templates)) ? r.templates
                : (r && Array.isArray(r)) ? r
                : [];
      if (arr.length) {
        _sgTemplatesCache = arr.map((tp) => {
          const meta = SG_NEW_META[tp.name] || {};
          return {
            name: tp.name,
            title: tp.title || meta.title || '',
            rarity: tp.rarity || 'common',
            attack: Number(tp.attack || 0),
            defense: Number(tp.defense || 0),
            identity: tp.identity || meta.identity || tp.faction || '',
            // 🟢 O-1：保留编队 cost（CardTemplate.cost，Σcost ≤ params.team_cost_cap），
            //    供战斗前预检，避免 Σcost 超限的必败交易白烧 gas
            cost: (tp.cost != null) ? Number(tp.cost) : null,
            // 🟢 战斗属性补全（2026-10-14）：兵种/技能/连携/阵营，供详情/图鉴/养成/战斗展示
            troop: tp.troop || '',
            faction: tp.faction || '',
            skill_id: tp.skill_id || '',
            bonds: tp.bonds || [],
          };
        });
        SG_TPL_COUNT = _sgTemplatesCache.length;
        const cnt = document.getElementById('sgCodexCount');
        if (cnt) cnt.textContent = SG_TPL_COUNT;
        return _sgTemplatesCache;
      }
    } catch (e) {
      console.warn('[loadSanguoTemplates] 链上查询失败，回退本地模板:', e && e.message);
    }
    return CARD_TEMPLATES;   // 回退：始终保证图鉴可用
  }
  window.loadSanguoTemplates = loadSanguoTemplates;

  const RARITY_LABEL = {
    legend: { zh: '传说', en: 'Legend' },
    epic: { zh: '史诗', en: 'Epic' },
    rare: { zh: '稀有', en: 'Rare' },
    common: { zh: '普通', en: 'Common' },
  };
  function rarityLabel(r) {
    const l = (window.HUB_LANG === 'en') ? 'en' : 'zh';
    return esc((RARITY_LABEL[r] && RARITY_LABEL[r][l]) || r || '');
  }
  function power(c) { return (Number(c.attack || 0) + Number(c.defense || 0)); }

  // ---- 阵营（identity）辅助（2026-09-29）----
  // 链上返回的玩家卡只带 name/rarity/attack/defense/star/level，不带阵营；
  // 图鉴模板（链上优先、本地兜底）带 identity（如「蜀·五虎将」）。按名字查表补齐。
  function sgTplByName(name) {
    const src = (_sgTemplatesCache && _sgTemplatesCache.length) ? _sgTemplatesCache : CARD_TEMPLATES;
    return src.find((t) => t && t.name === name) || CARD_TEMPLATES.find((t) => t.name === name) || null;
  }
  function sgCardIdentity(c) {
    if (!c) return '';
    const tpl = sgTplByName(c.name);
    return (tpl && (tpl.identity || tpl.faction)) || c.identity || '';
  }
  // 阵营配色：取 identity「·」前首字（魏/蜀/吴/汉/群），其余用中性色
  const SG_FACTION_COLORS = { '魏': '#5aa7ff', '蜀': '#ff6b5e', '吴': '#3ecf8e', '汉': '#e8b04b', '群': '#b48cff' };
  function sgFactionColor(idt) {
    const f = String(idt || '').split('·')[0].trim();
    return SG_FACTION_COLORS[f] || '#a89a8a';
  }

  // 对战里展示玩家地址：只保留前 15 个字符，其余用省略号代替（避免长地址撑破排版）
  function sgShortAddr(a) {
    const s = String(a || '');
    if (s.length <= 15) return s;
    return s.slice(0, 15) + '…';
  }

  // ============================================================
  // 🟢 交易金额自解析（**纯展示层，不改任何业务逻辑**）
  //    TKCC 是 PRC-20(cw20) 代币，链上精度 6。领奖类交易在合约内部会发两条子事件：
  //      transfer（把奖励打给玩家）  +  burn（按 5% 抽水销毁）
  //    第三方钱包常只取"最后一条 PRC-20 事件"→ 把 burn 当作到账额显示
  //    （实测：真实到账 168,000 TKCC 被钱包显示成 36,000 TKCC）。
  //    这里由前端直接读本次交易的 transfer 事件，把**真实到账额**提示给玩家，
  //    玩家无需再回钱包对账。
  // ============================================================
  function sgTkccEvents(tx) {
    const out = { inbound: 0n, burn: 0n };
    if (!tx) return out;
    let self = '';
    try { self = (state.wallet && state.wallet.address) || ''; } catch (_) { self = ''; }
    const evs = [...(tx.events || [])];
    for (const log of tx.logs || []) evs.push(...(log.events || []));
    for (const ev of evs) {
      if (!ev || ev.type !== 'wasm') continue;
      const m = {};
      for (const a of ev.attributes || []) m[a.key] = a.value;   // 本节点 attributes 为明文，勿盲目 base64 解码
      if (m.action === 'transfer' && m.amount && m.to === self) {
        try { out.inbound += BigInt(m.amount); } catch (_) { /* 忽略异常值 */ }
      } else if (m.action === 'burn' && m.amount) {
        try { out.burn += BigInt(m.amount); } catch (_) { /* 忽略异常值 */ }
      }
    }
    return out;
  }

  /** 领奖成功提示：优先显示本次真实到账额；解析不到则回退原文案（如合约改为内部记账时） */
  function sgClaimToast(tx, fallbackKey) {
    // 🟢 合规化：领奖现发放碎片（非 TKCC），优先展示链上 reward 碎片字符串
    try {
      const ev = parseTxEvents(tx, ['reward']);
      const reward = ev.reward && ev.reward[0];
      if (reward) {
        showToast(tf('claim_frag', { frag: reward }), 'success');
        return;
      }
    } catch (e) { /* 解析失败回退 */ }
    const m = sgTkccEvents(tx);
    if (m.inbound > 0n) {
      const key = (m.burn > 0n) ? 'claim_in_burn' : 'claim_in';
      showToast(tf(key, {
        amt: fromRawUnits(String(m.inbound), 6),
        burned: fromRawUnits(String(m.burn), 6),
      }), 'success');
      return;
    }
    showToast(t(fallbackKey), 'success');
  }

  /** 消耗类操作（建房/加入/挑战）成功提示：写明本次扣了多少 TKCC（从合约内余额扣，钱包里看不到） */
  function sgSpentTip(whatKey, rawFee) {
    showToast(tf('spent_tip', {
      what: t(whatKey),
      amt: fromRawUnits(String(rawFee || 0), 6),
    }), 'success');
  }
  // ============================================================
  // 🟢 技能/连携前端镜像表（2026-10-14，与合约 battle/skills.rs / bonds.rs
  //    逐条同步，技能名以《三国卡牌V2设计终稿》文档 2 为准）。
  //    合约未提供查询接口，此表为硬编码快照——合约侧改数值/加技能须同步本表。
  //    格式：id: [名, 触发, attack_bp, defense_bp, power_flat_bp, 全队(0/1), 叠层, 对手(0/1)]
  // ============================================================
  const SG_TRIGGER_ZH = { OnBattleStart: '开战时', OnGroupStart: '每组开始', OnWinGroup: '赢组后', OnLoseGroup: '输组后', OnLowPower: '战力低时', OnHighPower: '战力高时' };
  const SG_TRIGGER_EN = { OnBattleStart: 'Battle start', OnGroupStart: 'Group start', OnWinGroup: 'After a won group', OnLoseGroup: 'After a lost group', OnLowPower: 'When power is lower', OnHighPower: 'When power is higher' };
  const SG_SKILLS = {
    // 传奇（10）
    jian_xiong: ['奸雄', 'OnWinGroup', 1800, 0, 0, 0, 1, 0],
    kong_cheng: ['空城', 'OnLowPower', 0, 3500, 0, 0, 1, 0],
    wu_sheng: ['武圣', 'OnBattleStart', 2800, 0, 0, 0, 1, 0],
    long_dan: ['龙胆', 'OnLoseGroup', 1800, 0, 0, 0, 2, 0],
    wu_shuang: ['无双', 'OnHighPower', 2200, 0, 0, 0, 1, 0],
    zhong_hu: ['冢虎', 'OnLowPower', 0, 3000, 0, 0, 1, 0],
    ren_de: ['仁德', 'OnBattleStart', 0, 1800, 0, 1, 1, 0],
    zhi_heng: ['制衡', 'OnWinGroup', 0, 0, 1000, 1, 2, 0],
    jiang_dong_meng_hu: ['江东猛虎', 'OnBattleStart', 2200, 0, 0, 0, 1, 0],
    bao_nue: ['暴虐', 'OnWinGroup', 0, -1800, 0, 0, 1, 1],
    // 史诗（16）
    pao_xiao: ['咆哮', 'OnBattleStart', 2200, -800, 0, 0, 1, 0],
    xi_liang_tie_qi: ['西凉铁骑', 'OnBattleStart', 1600, 0, 0, 0, 1, 0],
    bai_bu_chuan_yang: ['百步穿杨', 'OnHighPower', 2000, 0, 0, 0, 1, 0],
    qi_lin: ['麒麟', 'OnLoseGroup', 1600, 1600, 0, 0, 1, 0],
    huo_gong: ['火攻', 'OnWinGroup', 0, -1400, 0, 0, 1, 1],
    lian_ying: ['连营', 'OnWinGroup', 0, 0, 1100, 0, 1, 0],
    ba_shi_dan_jing: ['拔矢啖睛', 'OnLoseGroup', 2400, 0, 0, 0, 1, 0],
    wei_zhen_xiao_yao_jin: ['威震逍遥津', 'OnLowPower', 2200, 0, 0, 0, 1, 0],
    gui_cai: ['鬼才', 'OnBattleStart', 0, 0, 1200, 1, 1, 0],
    hu_chi: ['虎痴', 'OnHighPower', 0, 2200, 0, 0, 1, 0],
    qiao_bian: ['巧变', 'OnGroupStart', 0, 0, 900, 0, 1, 0],
    ku_rou: ['苦肉', 'OnLoseGroup', 2800, -800, 0, 0, 1, 0],
    gong_yao_ji: ['弓腰姬', 'OnBattleStart', 1800, 0, 0, 0, 1, 0],
    lin_wei: ['临危', 'OnLowPower', 0, 0, 1200, 1, 1, 0],
    shen_yi: ['神医', 'OnWinGroup', 0, 0, 1400, 0, 1, 0],
    he_bei_ting_zhu: ['河北庭柱', 'OnBattleStart', 2500, 0, 0, 0, 1, 0],
    // 稀有（18）
    qi_mou: ['奇谋', 'OnLowPower', 1800, 0, 0, 0, 1, 0],
    lian_huan: ['连环', 'OnBattleStart', 0, 0, 900, 1, 1, 0],
    qi_hua: ['奇画', 'OnWinGroup', 1400, 0, 0, 0, 1, 0],
    jin_fan: ['锦帆', 'OnBattleStart', 1400, 0, 0, 0, 1, 0],
    shen_she: ['神射', 'OnHighPower', 1600, 0, 0, 0, 1, 0],
    xiao_ba_wang: ['小霸王', 'OnBattleStart', 1600, 0, 0, 0, 1, 0],
    bai_yi_du_jiang: ['白衣渡江', 'OnLowPower', 0, 0, 1300, 0, 1, 0],
    tou_du_yin_ping: ['偷渡阴平', 'OnLowPower', 0, 0, 1100, 1, 1, 0],
    wang_zuo: ['王佐', 'OnBattleStart', 0, 1400, 0, 1, 1, 0],
    luo_shen: ['洛神', 'OnBattleStart', 0, 1200, 0, 1, 1, 0],
    guo_se: ['国色', 'OnWinGroup', 0, 0, 900, 1, 1, 0],
    tian_xiang: ['天香', 'OnWinGroup', 0, 1200, 0, 1, 1, 0],
    bu_qu: ['不屈', 'OnLoseGroup', 0, 2400, 0, 0, 1, 0],
    ji_guan: ['机关', 'OnBattleStart', 0, 1200, 0, 1, 1, 0],
    an_guo: ['安国', 'OnWinGroup', 1500, 0, 0, 0, 1, 0],
    hu_si: ['虎嗣', 'OnBattleStart', 1400, 0, 0, 0, 1, 0],
    gong_tai: ['公台', 'OnLowPower', 1600, 0, 0, 0, 1, 0],
    bi_yue: ['闭月', 'OnWinGroup', -1200, 0, 0, 0, 1, 1],
    // 普通（16）
    xian_feng: ['先锋', 'OnBattleStart', 1000, 0, 0, 0, 1, 0],
    bian_shi: ['辩士', 'OnBattleStart', 0, 0, 600, 1, 1, 0],
    shi_ming: ['使命', 'OnWinGroup', 0, 0, 700, 1, 1, 0],
    fu_shang: ['富商', 'OnBattleStart', 0, 900, 0, 1, 1, 0],
    dun_hou: ['敦厚', 'OnBattleStart', 0, 800, 0, 1, 1, 0],
    lian_meng: ['联盟', 'OnWinGroup', 0, 900, 0, 1, 1, 0],
    mou_zhu: ['谋主', 'OnLowPower', 0, 1200, 0, 0, 1, 0],
    du_shi: ['毒士', 'OnWinGroup', 0, -1000, 0, 0, 1, 1],
    piao_qi: ['骠骑', 'OnBattleStart', 1200, 0, 0, 0, 1, 0],
    mou_luan: ['谋乱', 'OnLowPower', 1200, 0, 0, 0, 1, 0],
    wen_hou: ['文侯', 'OnBattleStart', 0, 900, 0, 1, 1, 0],
    an_guo_2: ['安国', 'OnBattleStart', 1000, 0, 0, 0, 1, 0],
    tan_zhi: ['坦之', 'OnBattleStart', 1100, 0, 0, 0, 1, 0],
    zhong_yong: ['忠勇', 'OnBattleStart', 0, 1400, 0, 0, 1, 0],
    gang_zhi: ['刚直', 'OnLowPower', 0, 0, 900, 1, 1, 0],
    zheng_nan: ['正南', 'OnBattleStart', 0, 800, 0, 1, 1, 0],
  };
  const SG_BONDS = [
    { id: 'wuhu_shangjiang', name: '五虎上将', faction: 'shu', members: ['关羽', '张飞', '赵云', '马超', '黄忠'], base: 3, baseBp: 800, full: 5, fullBp: 1800 },
    { id: 'taoyuan_jieyi', name: '桃园结义', faction: 'shu', members: ['刘备', '关羽', '张飞'], base: 2, baseBp: 600, full: 3, fullBp: 1500 },
    { id: 'wolong_fengchu', name: '卧龙凤雏', faction: 'shu', members: ['诸葛亮', '庞统'], base: 2, baseBp: 1000, full: 0, fullBp: 0 },
    { id: 'shuhan_sanjie', name: '蜀汉三杰', faction: 'shu', members: ['诸葛亮', '关羽', '张飞'], base: 2, baseBp: 600, full: 3, fullBp: 1400 },
    { id: 'guanyu_fuzi', name: '关羽父子', faction: 'shu', members: ['关羽', '关平', '关兴'], base: 2, baseBp: 600, full: 3, fullBp: 1200 },
    { id: 'zhangfei_fuzi', name: '张飞父子', faction: 'shu', members: ['张飞', '张苞'], base: 2, baseBp: 800, full: 0, fullBp: 0 },
    { id: 'shuhan_mingjiang', name: '蜀汉名将', faction: 'shu', members: ['姜维', '魏延', '马岱', '廖化'], base: 2, baseBp: 600, full: 4, fullBp: 1200 },
    { id: 'wuzi_liangjiang', name: '五子良将', faction: 'wei', members: ['张辽', '张郃'], base: 2, baseBp: 800, full: 0, fullBp: 0 },
    { id: 'caowei_shuangbi', name: '曹魏双璧', faction: 'wei', members: ['曹操', '司马懿'], base: 2, baseBp: 1200, full: 0, fullBp: 0 },
    { id: 'xunyu_guojia', name: '荀彧郭嘉', faction: 'wei', members: ['荀彧', '郭嘉'], base: 2, baseBp: 1000, full: 0, fullBp: 0 },
    { id: 'xuchu_huwei', name: '许褚虎卫', faction: 'wei', members: ['许褚', '曹操'], base: 2, baseBp: 800, full: 0, fullBp: 0 },
    { id: 'weiwu_sanjiang', name: '魏武三将', faction: 'wei', members: ['夏侯惇', '张辽', '许褚'], base: 2, baseBp: 600, full: 3, fullBp: 1400 },
    { id: 'dongwu_dudu', name: '东吴都督', faction: 'wu', members: ['周瑜', '鲁肃', '吕蒙', '陆逊'], base: 2, baseBp: 600, full: 4, fullBp: 1600 },
    { id: 'jiangdong_shuangbi', name: '江东双璧', faction: 'wu', members: ['孙策', '周瑜'], base: 2, baseBp: 1200, full: 0, fullBp: 0 },
    { id: 'sunshi_sanxiong', name: '孙氏三雄', faction: 'wu', members: ['孙坚', '孙策', '孙权'], base: 2, baseBp: 800, full: 3, fullBp: 1600 },
    { id: 'erqiao', name: '二乔', faction: 'wu', members: ['大乔', '小乔'], base: 2, baseBp: 1000, full: 0, fullBp: 0 },
    { id: 'sunshangxiang_gongyaoji', name: '弓腰姬', faction: 'wu', members: ['孙尚香', '刘备'], base: 2, baseBp: 800, full: 0, fullBp: 0 },
    { id: 'ganning_taishici', name: '甘宁太史慈', faction: 'wu', members: ['甘宁', '太史慈'], base: 2, baseBp: 800, full: 0, fullBp: 0 },
    { id: 'huanggai_kurou', name: '黄盖苦肉', faction: 'wu', members: ['黄盖', '周瑜'], base: 2, baseBp: 1000, full: 0, fullBp: 0 },
    { id: 'lvbu_diaochan', name: '吕布貂蝉', faction: 'qun', members: ['吕布', '貂蝉'], base: 2, baseBp: 1200, full: 0, fullBp: 0 },
    { id: 'dongzhuo_lvbu', name: '董卓吕布', faction: 'qun', members: ['董卓', '吕布'], base: 2, baseBp: 1000, full: 0, fullBp: 0 },
    { id: 'qunxiong_zhulu', name: '群雄逐鹿', faction: 'qun', members: ['吕布', '董卓', '颜良', '华佗'], base: 2, baseBp: 600, full: 4, fullBp: 1400 },
    { id: 'hebei_tingzhu', name: '河北庭柱', faction: 'qun', members: ['颜良', '审配', '田丰'], base: 2, baseBp: 600, full: 3, fullBp: 1200 },
  ];
  const SG_BOND_BY_ID = Object.fromEntries(SG_BONDS.map((b) => [b.id, b]));
  function sgFindSkill(id) { return id ? (SG_SKILLS[id] || null) : null; }
  /** 技能可读描述：如「奸雄 · 赢组后 攻+18%」「暴虐 · 赢组后 使对手 防−18%」 */
  function sgSkillDesc(id) {
    const s = sgFindSkill(id);
    if (!s) return id || '';
    const en = window.HUB_LANG === 'en';
    const trLab = (en ? SG_TRIGGER_EN : SG_TRIGGER_ZH)[s[1]] || s[1];
    const pc = (v) => (v > 0 ? '+' : '−') + (Math.abs(v) / 100) + '%';
    let eff = '';
    if (s[2]) eff += (en ? 'ATK' : '攻') + pc(s[2]) + ' ';
    if (s[3]) eff += (en ? 'DEF' : '防') + pc(s[3]) + ' ';
    if (s[4]) eff += (en ? 'PWR' : '战力') + pc(s[4]) + ' ';
    if (s[7]) eff = (en ? 'debuff foe ' : '使对手 ') + eff.trim();
    if (s[5]) eff += en ? ' (team)' : '（全队）';
    if (s[6] > 1) eff += ' ×' + s[6];
    return `${s[0]} · ${trLab} ${eff.trim()}`;
  }
  /** bond id 列表 → 中文名列表 */
  function sgBondNames(bondIds) {
    return (bondIds || []).map((bid) => (SG_BOND_BY_ID[bid] ? SG_BOND_BY_ID[bid].name : bid)).join('、');
  }
  /** S3 单档封顶：按 9 张卡名算全队激活的最高连携档（null = 未激活）。
      ⚠️ 与合约 bond_multiplier_bp 同步（不含 bond_strength_bp 缩放，展示用） */
  function sgBondActive(names) {
    let best = null;
    for (const b of SG_BONDS) {
      const cnt = b.members.filter((m) => names.includes(m)).length;
      let bp = 0, tier = '';
      if (b.full && cnt >= b.full) { bp = b.fullBp; tier = 'full'; }
      else if (cnt >= b.base) { bp = b.baseBp; tier = 'base'; }
      if (bp > 0 && (!best || bp > best.bp)) best = { id: b.id, name: b.name, bp, tier, cnt, need: tier === 'full' ? b.full : b.base };
    }
    return best;
  }
  const RARITY_ORDER = { legend: 0, epic: 1, rare: 2, common: 3 };
  void RARITY_ORDER; // 保留备用（排序用）
  function rarityColor(r) {
    return { legend: '#fbbf24', epic: '#a78bfa', rare: '#60a5fa', common: '#cbd5e1' }[r] || '#cbd5e1';
  }

  async function requireSanguo() {
    if (!state.connected) {
      const ok = await connectWallet(false);
      if (!ok) throw new Error(t('connect_first'));
    }
    const r = await Session.ensure();
    if (!r.ok) {
      showBusy(t('register_session'));
      try { await Session.register(); } finally { hideBusy(); }
    }
  }

  // ===================== 三国专用签名 + 执行 =====================
  /**
   * 生成 round_id。
   *
   * ⚠️ 格式为 {action}_{blockTime}_{nonce}_{rand}，其中 action 冗余嵌入仅供调试用，
   *    合约只做字符串比较，不解析 round_id 内部结构。
   *    blockTime 取自链上最新区块时间（getBlockTime，内部缓存 5 秒），仅用于增强唯一性。
   *
   *  ℹ️ 更正旧注释：合约验签时直接使用消息里下发的 round_id 原值
   *    （games/mod.rs::validate_and_consume_session 签名原文第 6 段），
   *    并不自行用 env.block.time 计算，因此不存在「区块时间漂移导致验签失败」的问题。
   *    防重放由 nonce 递增保证，round_id 只需保证同 action 下不重复。
   */
  async function sanguoRoundId(action) {
    const T = await getBlockTime();
    return `${action}_${T}_${state.sessNonce}_${Math.floor(Math.random() * 1e6)}`;
  }

  /**
   * 统一签名并执行一个 Sanguo* 消息。
   *
   * ⚠️ opts.action 必须与合约 sanguo_auth 里的 action 完全一致，否则验签会失败。
   *    取值集合（与合约 sanguo_auth 一一对应）：
   *      draw_pack | draw_pack3 | ai_battle | claim_reward | set_battle_order |
   *      star_up | decompose | upgrade | craft | propose | vote | execute_proposal |
   *      cancel_proposal | create_pvp | accept_pvp | cancel_pvp | claim_pvp |
   *      create_royale | join_royale | settle_royale | claim_royale
   *
   *    opts.spend 必须与合约 sanguo_auth 收到的 spend 完全一致（参与签名原文）：
   *      ai_battle → params.ai_fee[diff-1]，create/accept_pvp → params.pvp_fee，
   *      create/join_royale → params.royale_entry_fee，其余为 0。
   *
   * @param variant  PascalCase 执行消息名，如 'SanguoDraw'
   * @param fields   业务字段（不含 round_id/session_addr/nonce/signature）
   * @param opts     { action, spend=0, funds=[] }
   */
  async function sanguoExec(variant, fields, opts) {
    const action = opts.action;
    const spend = opts.spend || 0;

    // 🟢 修复（低危 2）：显式同步链上 nonce，把「调用方必须先调 requireSanguo()」
    //    这一隐式契约显式化 —— 将来新增入口若漏调 requireSanguo，这里仍能兜住。
    //    同步失败不阻断，沿用本地缓存 nonce（与修复前行为一致）。
    try { await Session.syncFromChain(); } catch (e) { /* 沿用本地 nonce */ }

    // 🟢 修复（2026-09-18）：签名守卫 + nonce 漂移自动重试。
    //    此前发生过：手机钱包内置浏览器缓存旧版 session.js → Session.sign 返回空串 →
    //    带 signature:"" 的必败消息仍被推给钱包弹窗 → 用户确认后合约才拒绝。
    //    现在签名不为 128 位 hex 就地报错并提示强刷；nonce 类错误自动重同步重试一次。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const roundId = await sanguoRoundId(action);
      const message = Session.buildMessage({
        gameId: 'sanguo',
        action,
        roundId,
        amountPayout: spend,
        nonce: state.sessNonce,
        extra: opts.extra,
      });
      const sig = await Session.sign(message);
      if (!sig || !/^[0-9a-f]{128}$/.test(sig)) {
        throw new Error(t('err_sig_format'));
      }
      // ⚠️ 合约 ExecuteMsg 用 #[cw_serde] → 枚举变体按 snake_case 序列化
      //    (SanguoDraw → "sanguo_draw")。此前误用帕斯卡命名会被合约拒绝为 unknown variant。
      //    统一在此处把 PascalCase 变体名转成 snake_case，调用方无需改动。
      const msgKey = variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      const payload = {
        [msgKey]: {
          ...fields,
          round_id: roundId,
          session_addr: state.sessAddr,
          nonce: state.sessNonce,
          signature: sig,
        },
      };
      try {
        const hash = await execContract(payload, opts.funds || [], '', opts);
        const tx = await waitForTx(hash);
        Session.bumpNonce();
        // tx 一并返回：调用方可以直接用 parseTxEvents 读本次交易的 attributes，
        // 不必再 poll 一次同一条交易。
        return { hash, roundId, tx };
      } catch (e) {
        // nonce 漂移（换设备/上笔失败/多标签页）→ 重同步链上 nonce 后整体重建
        // round_id + 签名再试一次；其他错误原样抛出。
        if (attempt < 2 && /nonce/i.test(String(e && e.message))) {
          try { await Session.syncFromChain(); } catch (_) { /* 保持本地 nonce */ }
          continue;
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  // ============================================================
  // 老三国卡牌合约（只读，不修改）
  //  地址：paxi1lqjxm6zdvz9sf0lx3280gjj598lqenxeraesfv5334gpnsarc7eqku0zwu
  //  code_id 28 / label 三国卡牌-首发30张 / 未被 migrate（仍存活）
  //
  // 它的 QueryMsg **不带 sanguo_ 前缀**，与新合约不同（跨合约查询由合约侧发起，
  // 这里只是给前端做「迁移前预览」用；迁移本身是合约去查老合约）。
  // 已知可用变体：config / player_cards / get_fragments / rarity_count / …
  // ============================================================
  const OLD_SANGUO_CONTRACT = 'paxi1lqjxm6zdvz9sf0lx3280gjj598lqenxeraesfv5334gpnsarc7eqku0zwu';

  // ===================== 状态 =====================
  let userCards = [];        // CardInfo[]
  let sanguoTab = 'shop';
  let sgJustDrew = false;   // 抽卡成功后置位：下一帧「我的卡牌」网格里的卡走翻牌入场
  let paramsCache = null;
  let tapCountCache = 0;     // 从 sanguo_config 读取的抽水地址数量；查询失败保持 0，doDraw 会拒绝（审计 P2-1）
  let sanguoPicked = [];     // 养成-出战顺序 / PVP / 混战 选中的 card_id 列表
  let sgBatchMode = false;   // 我的卡 - 批量分解模式（P1-9）
  let sgBatchSel = new Set(); // 批量分解选中的 card_id
  let sgPendingAction = null; // 'accept_pvp' | 'join_royale'（通用卡牌选择面板）
  let sgPendingId = null;     // 对应的 match_id / royale_id
  // 🟢 3A：碎片合成消耗改为链上派生（sgCraftCost），不再硬编码，避免与合约 CRAFT_COST 漂移
  // 体力包价格（upaxi）——2026-10-12 起改为链上可调：读 sanguo_params.stamina_pack_price，
  // 未加载/为 0 时兜底默认 2 PAXI（与合约 state.rs::STAMINA_PACK_PRICE 一致）
  const STAMINA_PACK_PRICE_DEFAULT_UPAXI = 2_000_000;
  function staminaPackPriceUpaxi() {
    const v = paramsCache && paramsCache.stamina_pack_price != null ? Number(paramsCache.stamina_pack_price) : 0;
    return v > 0 ? v : STAMINA_PACK_PRICE_DEFAULT_UPAXI;
  }
  let sgFrags = { common: 0, rare: 0, epic: 0, legend: 0 };  // 合成区用的四档碎片余额

  // 收入对账页仅对管理员钱包可见（管理员 = 部署者钱包）
  const SG_ADMIN = 'paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd';
  function isSgAdmin() {
    return !!(state.wallet && state.wallet.address && state.wallet.address === SG_ADMIN);
  }

  // 合规版页签（2026-10-10）：免费抽卡 → 我的卡 → 商店 → 关卡 → 养成 → 收入对账(管理员)
  // AI对战 / PVP / 混战 / 提案在合规合约下被禁（涉代币博弈），入口整体下线。
  const SANGUO_TABS = [
    { id: 'draw',      key: 'tab_draw' },
    { id: 'mycards',   key: 'tab_mycards' },
    { id: 'shop',      key: 'tab_shop' },
    { id: 'stage',     key: 'tab_stage' },
    { id: 'cultivate', key: 'tab_cultivate' },
    { id: 'ranked',    key: 'tab_ranked' },
    { id: 'pvp',       key: 'tab_pvp' },
    { id: 'royale',    key: 'tab_royale' },
    { id: 'dailytask', key: 'tab_dailytask' },
    { id: 'help',      key: 'tab_help' },
    { id: 'gift',      key: 'tab_gift' },
    // 🟢 参数收敛（2026-10-14）：战斗系数管理员热更面板（克制/稀有度/技能/连携强度）
    { id: 'battleparams', key: 'tab_battleparams', admin: true },
    // 🟢 2026-10-12：收入对账 tab 移除——对账数据是老合约的抽水事件，新合约无意义（用户拍板取消）
    // { id: 'ledger',    key: 'tab_ledger', admin: true },
  ];

  // 🟢 合规配置缓存（sanguo_compliance 查询；老合约没有该查询时返回 null → 走旧逻辑）
  let sgCompliance = null;
  async function loadCompliance(force) {
    if (sgCompliance && !force) return sgCompliance;
    try {
      sgCompliance = await queryContract({ sanguo_compliance: {} });
    } catch (e) { sgCompliance = null; }
    return sgCompliance;
  }

  // 🟢 合规闸：TKCC 对战（AI/PVP/混战）入口在合规模式下一律拦截。
  //    合约端同名入口同样拒绝（双保险）；cancel/claim 通道保留（存量对局退出口）。
  async function complianceGate() {
    const cp = await loadCompliance();
    if (cp && cp.compliance_mode) {
      showToast(t('compliance_disabled'), 'error');
      return true;
    }
    return false;
  }

  async function loadParams() {
    try {
      const r = await queryContract({ sanguo_params: {} });
      paramsCache = r;
    } catch (e) { paramsCache = null; }
    try {
      const c = await queryContract({ sanguo_config: {} });
      // 🟢 修复（中危 3）：查询成功即覆盖，包括长度 0。
      //    旧写法带 `.length` 真值判断，管理员把 tap_addresses 清空（改为 []）后
      //    tapCountCache 仍保留旧值，前端继续发越界 tap_index → 合约 SanguoInvalidTap，
      //    表现为「明明改了链上配置，抽卡反而报错」。
      tapCountCache = (c && Array.isArray(c.tap_addresses)) ? c.tap_addresses.length : 0;
    } catch (e) {
      tapCountCache = 0;
    }
    return paramsCache;
  }

  // 审计 #15：查询失败时直接抛错，不再用硬编码默认值发交易
  function requireParams() {
    if (!paramsCache) throw new Error(t('params_err'));
    return paramsCache;
  }
  function paxiFeeRaw(pack3) {
    const p = requireParams();
    const v = pack3 ? p.pack3_paxi_fee : p.single_paxi_fee;
    if (v == null) throw new Error(t('params_err'));
    return BigInt(v);
  }
  function prcTotalRaw(pack3) {
    const p = requireParams();
    const v = pack3 ? p.pack3_prc_total : p.single_prc_total;
    if (v == null) throw new Error(t('params_err'));
    return BigInt(v);
  }

  async function loadSanguoCards() {
    if (!state.wallet) return;
    try {
      const r = await queryContract({ sanguo_player_cards: { address: state.wallet.address } });
      userCards = r.cards || [];
    } catch (e) { userCards = []; }
  }

  // ============================================================
  // 入口：从大厅卡片进入
  // ============================================================
  window.openSanguo = function () {
    if (!hasGameContract()) {
      showToast(t('contract_missing'), 'error');
      switchTab('me');
      return;
    }
    renderSanguo();
  };

  function renderSanguo() {
    const main = $('main');
    $('pageTitle').textContent = t('sg_title');
    // 注：包裹在 .sg-page 内 —— 老版金色主题只作用于三国页内部，大厅保持中性、其他游戏不动
    main.innerHTML = `
      <div class="sg-page">
        <!-- 🟢 合规版：大厅已移除，打开即三国，无需返回条 -->
        <div class="sg-stats">
          <div class="sg-stat"><span class="ic">🏆</span><span class="num" id="sgWin">—</span><span class="lb">${t('sg_stat_wins')}</span></div>
          <div class="sg-stat"><span class="ic">🃏</span><span class="num" id="sgStatCards">0</span><span class="lb">${t('sg_stat_cards')}</span></div>
          <div class="sg-stat"><span class="ic">⚔️</span><span class="num" id="sgBattle">—</span><span class="lb">${t('sg_stat_battles')}</span></div>
          <div class="sg-stat"><span class="ic">🧩</span><span class="num" id="sgFrag" style="color:#ffd700">0</span><span class="lb">${t('sg_stat_frag')}</span></div>
        </div>
        <div class="card">
          <div class="card-title">${t('sg_title')}</div>
          <div class="desc">${t('sg_subtitle')}</div>
        </div>
        <div class="card">
          <button class="btn btn-gold" onclick="openCodex()" style="width:100%">${tf('codex_open', { n: '<span id="sgCodexCount">' + SG_TPL_COUNT + '</span>' })}</button>
        </div>
        <div id="sgTabs">
          ${SANGUO_TABS.filter((tb) => !tb.admin || isSgAdmin()).map((tb) => tabBtn(tb.id, t(tb.key))).join('')}
        </div>
        <div id="sgBody"></div>
        <div class="battle-arena" id="battleArena"></div>
      </div>`;
    document.querySelectorAll('#sgTabs .sg-tab').forEach((b) => {
      b.onclick = () => { sanguoTab = b.dataset.tab; updateSgTabs(); renderSanguoTab(); };
    });
    updateSgTabs();
    renderSanguoTab();
    // 图鉴入口计数异步刷新（链上模板加载完成后自动更新 30 → 60）
    loadSanguoTemplates().then((arr) => {
      const el = document.getElementById('sgCodexCount');
      if (el && Array.isArray(arr)) el.textContent = arr.length;
    }).catch(() => {});
    sgSyncWallet();
  }

  function tabBtn(id, label) {
    return `<button class="sg-tab btn btn-ghost btn-sm" data-tab="${id}" style="white-space:nowrap">${label}</button>`;
  }
  function updateSgTabs() {
    document.querySelectorAll('#sgTabs .sg-tab').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.tab === sanguoTab);
      b.classList.toggle('btn-ghost', b.dataset.tab !== sanguoTab);
    });
  }

  // ============================================================
  // 🟢 玩法说明页（2026-10-10）：面向玩家的完整玩法指南 + 收费表 + 合规说明。
  //    静态内容走 i18n（help_* 键），动态数值（体力价格/每日抽卡限次）尽量取链上缓存。
  // ============================================================
  function renderHelp(body) {
    const p = paramsCache;
    const cp = sgCompliance;
    // 🟢 战斗规则动态系数行（0 = 回退默认，展示生效值）
    const sgHelpBpRow = (pp, k, d) => {
      const v = (pp && pp[k] != null && Number(pp[k]) !== 0) ? Number(pp[k]) : d;
      return `<div class="kv"><span class="k" style="font-size:10px;color:#9fb3d1">${k}</span><span class="v">${(v / 100).toFixed(0)}%</span></div>`;
    };
    // 体力包价格：链上可调（sanguo_params.stamina_pack_price，0 = 默认 2 PAXI）
    const staminaPrice = fromRawUnits(String(staminaPackPriceUpaxi()));
    const drawLimit = cp && cp.daily_draw_limit ? cp.daily_draw_limit : '—';
    const fragCap = cp && cp.daily_fragment_cap ? cp.daily_fragment_cap : '—';
    // 修复：参数未加载时兜底也必须按 6 位精度换算，避免把 5,000,000 upaxi 误标成 "5000000 PAXI"
    const cardPrice = (n) => p ? fromRawUnits(String(n)) : String(n / 1000000);
    body.innerHTML = `
      <div class="card">
        <div class="card-title">📖 ${t('help_title')}</div>
        <div class="desc">${t('help_intro')}</div>
        <div class="kv"><span class="k">${t('help_kv_compliance')}</span><span class="v" style="color:#22c55e">${t('help_kv_compliance_v')}</span></div>
        <div class="kv"><span class="k">${t('help_kv_drawlimit')}</span><span class="v">${drawLimit}</span></div>
        <div class="kv"><span class="k">${t('help_kv_fragcap')}</span><span class="v">${fragCap}</span></div>
      </div>

      <div class="card">
        <div class="card-title">⚔️ ${t('help_battle_title')}</div>
        <div class="desc">${t('help_battle_desc')}</div>
        <div class="kv"><span class="k">${t('help_faction_chain')}</span><span class="v">${t('help_faction_chain_v')}</span></div>
        <div class="kv"><span class="k">${t('help_troop_chain')}</span><span class="v">${t('help_troop_chain_v')}</span></div>
        <div class="kv"><span class="k">${t('help_skill_rule')}</span><span class="v">${t('help_skill_rule_v')}</span></div>
        <div class="kv"><span class="k">${t('help_bond_rule')}</span><span class="v">${t('help_bond_rule_v')}</span></div>
        <div class="kv"><span class="k">${t('help_coeff')}</span><span class="v" style="font-size:10px">${t('help_coeff_hint')}</span></div>
        ${sgHelpBpRow(p, 'faction_counter_bp', 11500)}${sgHelpBpRow(p, 'faction_countered_bp', 9000)}${sgHelpBpRow(p, 'troop_counter_bp', 11000)}${sgHelpBpRow(p, 'rarity_legend_bp', 11500)}${sgHelpBpRow(p, 'skill_strength_bp', 10000)}${sgHelpBpRow(p, 'bond_strength_bp', 10000)}
      </div>
      ${sgAiStats ? `<div class="card">
        <div class="card-title">📊 ${t('help_mystats_title')}</div>
        <div class="desc">${t('help_mystats_desc')}</div>
        <div class="kv"><span class="k">${t('help_mystats_all')}</span><span class="v">${sgAiStats.all_total != null ? sgAiStats.all_total : sgAiStats.total} / ${sgAiStats.all_wins != null ? sgAiStats.all_wins : sgAiStats.wins}</span></div>
        <div class="kv"><span class="k">${t('help_mystats_ai')}</span><span class="v">${sgAiStats.total} / ${sgAiStats.wins}</span></div>
        <div class="kv"><span class="k">${t('help_mystats_pvp')}</span><span class="v">${sgAiStats.pvp_total || 0} / ${sgAiStats.pvp_wins || 0}</span></div>
        <div class="kv"><span class="k">${t('help_mystats_royale')}</span><span class="v">${sgAiStats.royale_total || 0} / ${sgAiStats.royale_wins || 0}</span></div>
        <div class="kv"><span class="k">${t('help_mystats_stage')}</span><span class="v">${sgAiStats.stage_total || 0} / ${sgAiStats.stage_wins || 0}</span></div>
      </div>` : ''}

      <div class="card">
        <div class="card-title">🎴 ${t('help_draw_title')}</div>
        <div class="desc">${t('help_draw_desc')}</div>
        <div class="kv"><span class="k">${t('help_draw_cost')}</span><span class="v" style="color:#22c55e">${t('help_free')}</span></div>
        <div class="kv"><span class="k">${t('help_draw_pack3')}</span><span class="v">${t('help_draw_pack3_v')}</span></div>
      </div>

      <div class="card">
        <div class="card-title">🗺️ ${t('help_stage_title')}</div>
        <div class="desc">${t('help_stage_desc')}</div>
        <div class="kv"><span class="k">${t('help_cost')}</span><span class="v" style="color:#22c55e">${t('help_free')}</span></div>
        <div class="kv"><span class="k">${t('help_reward')}</span><span class="v">🧩 ${t('help_fragments')}</span></div>
      </div>

      <div class="card">
        <div class="card-title">⚔️ ${t('help_ranked_title')}</div>
        <div class="desc">${t('help_ranked_desc')}</div>
        <div class="kv"><span class="k">${t('help_cost')}</span><span class="v">⚡ 10 ${t('help_stamina')}</span></div>
        <div class="kv"><span class="k">${t('help_reward')}</span><span class="v">🧩 ${t('help_fragments')} + 🏆 ${t('help_seasonpts')}</span></div>
        <div class="kv"><span class="k">${t('help_ranked_rules')}</span><span class="v">${t('help_ranked_rules_v')}</span></div>
      </div>

      <div class="card">
        <div class="card-title">📅 ${t('help_daily_title')}</div>
        <div class="desc">${t('help_daily_desc')}</div>
        <div class="kv"><span class="k">T1</span><span class="v">${t('help_daily_t0')}</span></div>
        <div class="kv"><span class="k">T2</span><span class="v">${t('help_daily_t1')}</span></div>
        <div class="kv"><span class="k">T3</span><span class="v">${t('help_daily_t2')}</span></div>
        <div class="kv"><span class="k">T4</span><span class="v">${t('help_daily_t3')}</span></div>
      </div>

      <div class="card">
        <div class="card-title">🛒 ${t('help_shop_title')}</div>
        <div class="desc">${t('help_shop_desc')}</div>
        <div class="kv"><span class="k">${t('help_shop_card')}</span><span class="v">💰 ${cardPrice(5000000)} / ${cardPrice(15000000)} / ${cardPrice(40000000)} / ${cardPrice(100000000)} PAXI</span></div>
        <div class="kv"><span class="k">${t('help_shop_frag')}</span><span class="v">💰 1 / 4 / 12 / 30 PAXI</span></div>
        <div class="kv"><span class="k">${t('help_shop_stamina')}</span><span class="v">💰 ${staminaPrice} PAXI ${t('help_shop_stamina_v')}</span></div>
        <div class="kv"><span class="k">${t('help_shop_skin')}</span><span class="v">💰 ${t('help_shop_skin_v')}</span></div>
        <div class="kv"><span class="k">${t('help_shop_season')}</span><span class="v">💰 ${t('help_shop_season_v')}</span></div>
        <div class="kv"><span class="k">${t('help_shop_note')}</span><span class="v">${t('help_shop_note_v')}</span></div>
      </div>

      <div class="card">
        <div class="card-title">⚡ ${t('help_stamina_title')}</div>
        <div class="desc">${t('help_stamina_desc')}</div>
      </div>

      <div class="card">
        <div class="card-title">🧬 ${t('help_cult_title')}</div>
        <div class="desc">${t('help_cult_desc')}</div>
        <div class="kv"><span class="k">${t('help_cult_star')}</span><span class="v">🧩 50 / 100 / 200 / 500</span></div>
        <div class="kv"><span class="k">${t('help_cult_craft')}</span><span class="v">🧩 30 / 60 / 150 / 400</span></div>
        <div class="kv"><span class="k">${t('help_cult_decompose')}</span><span class="v">🧩 5 / 10 / 20 / 50</span></div>
      </div>

      <div class="card">
        <div class="card-title">🗳️ ${t('help_prop_title')}</div>
        <div class="desc">${t('help_prop_desc')}</div>
        <div class="kv"><span class="k">${t('help_prop_deposit')}</span><span class="v">💰 50 PAXI</span></div>
        <div class="kv"><span class="k">${t('help_prop_vote')}</span><span class="v">${t('help_prop_vote_v')}</span></div>
      </div>

      <div class="card">
        <div class="card-title">🛡️ ${t('help_safety_title')}</div>
        <div class="desc">${t('help_safety_desc')}</div>
        <div class="kv"><span class="k">${t('help_safety_frag')}</span><span class="v">${t('help_safety_frag_v')}</span></div>
        <div class="kv"><span class="k">${t('help_safety_session')}</span><span class="v">${t('help_safety_session_v')}</span></div>
      </div>

      <div id="sgHelpLog"></div>`;
  }

  async function renderSanguoTab() {
    const body = $('sgBody');
    if (!body) return;
    const fns = {
      draw: renderDraw,
      mycards: renderMyCards,
      shop: renderShop,
      stage: renderStage,
      cultivate: renderCultivate,
      ranked: renderRanked,
      dailytask: renderDailyTask,
      help: renderHelp,
      battleparams: renderBattleParams,
      // 🟢 合规化（T24 投票全禁）：提案 tab 已隐藏——源码已删 SanguoProposals 查询与提案入口，
      //    前端同步下线 renderProposal 分发，保证「前端无提案调用 ≡ 合约无提案入口」。
      // proposal: renderProposal,
      pvp: renderPvp,
      royale: renderRoyale,
      ledger: renderLedger,
      gift: renderGift,
    };
    // 收入对账页仅管理员可见：非管理员误入时回退到抽卡页
    if (sanguoTab === 'ledger' && !isSgAdmin()) { sanguoTab = 'draw'; }
    (fns[sanguoTab] || renderDraw)(body);
  }

  // ============================================================
  // 🎁 赠送系统（前端）：卡牌 / 碎片 / 皮肤
  //   extra 绑定串与合约 gift.rs 完全一致：
  //     card : {to}:card:{card_id}
  //     frag : {to}:frag:{rarity}:{amount}
  //     skin : {to}:skin:{skin_id}
  // ============================================================
  async function renderGift(body) {
    body.innerHTML = `
      <div class="card">
        <div class="card-title">🎁 ${t('gift_title')}</div>
        <div class="desc">${t('gift_desc')}</div>
        <div class="sg-gift-form">
          <label>${t('gift_to')}</label>
          <input id="giftTo" class="inp" placeholder="${t('gift_to_ph')}" />
          <label>${t('gift_kind')}</label>
          <div class="sg-gift-kinds">
            <label><input type="radio" name="giftKind" value="card" checked onchange="onGiftKindChange()"> ${t('gift_kind_card')}</label>
            <label><input type="radio" name="giftKind" value="frag" onchange="onGiftKindChange()"> ${t('gift_kind_frag')}</label>
            <label><input type="radio" name="giftKind" value="skin" onchange="onGiftKindChange()"> ${t('gift_kind_skin')}</label>
          </div>
          <div id="giftCardWrap">
            <label>${t('gift_card')}</label>
            <select id="giftCard" class="inp"></select>
          </div>
          <div id="giftFragWrap" style="display:none">
            <label>${t('gift_rarity')}</label>
            <select id="giftRarity" class="inp">
              <option value="common">${rarityLabel('common')}</option>
              <option value="rare">${rarityLabel('rare')}</option>
              <option value="epic">${rarityLabel('epic')}</option>
              <option value="legend">${rarityLabel('legend')}</option>
            </select>
            <label>${t('gift_amount')}</label>
            <input id="giftAmount" class="inp" type="number" min="1" value="1" />
          </div>
          <div id="giftSkinWrap" style="display:none">
            <label>${t('gift_skin')}</label>
            <select id="giftSkin" class="inp"></select>
          </div>
          <button class="btn btn-gold" id="giftBtn" style="width:100%;margin-top:8px" onclick="doGift()">${t('gift_send')}</button>
          <div id="giftMsg" class="hint" style="margin-top:6px"></div>
          <div class="hint" style="margin-top:6px">${t('gift_rules')}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">${t('gift_status')}</div>
        <div id="giftStatus" class="hint">${t('loading')}</div>
      </div>`;
    await loadGiftOptions();
    await refreshGiftStatus();
  }

  function onGiftKindChange() {
    const kind = (document.querySelector('input[name="giftKind"]:checked') || {}).value || 'card';
    const card = $('giftCardWrap'); if (card) card.style.display = kind === 'card' ? '' : 'none';
    const frag = $('giftFragWrap'); if (frag) frag.style.display = kind === 'frag' ? '' : 'none';
    const skin = $('giftSkinWrap'); if (skin) skin.style.display = kind === 'skin' ? '' : 'none';
  }

  async function loadGiftOptions() {
    try {
      const cards = await queryContract({ sanguo_player_cards: { address: state.wallet.address } });
      const cardSel = $('giftCard');
      if (cardSel) {
        cardSel.innerHTML = (cards.cards || []).map((c) =>
          `<option value="${esc(c.card_id)}">${esc(c.name)} · ${rarityLabel(c.rarity)}</option>`).join('')
          || `<option value="">${t('gift_no_card')}</option>`;
      }
      const sk = await queryContract({ sanguo_skins: {} }).catch(() => null);
      const psk = await queryContract({ sanguo_player_skins: { address: state.wallet.address } }).catch(() => null);
      const ownedIds = (psk && psk.skins) || [];
      const all = (sk && sk.skins) || [];
      const skinSel = $('giftSkin');
      if (skinSel) {
        skinSel.innerHTML = all.filter((s) => ownedIds.includes(s.id)).map((s) =>
          `<option value="${esc(s.id)}">${esc(s.name)} · ${rarityLabel(s.rarity)}</option>`).join('')
          || `<option value="">${t('gift_no_skin')}</option>`;
      }
    } catch (e) { /* 列表加载失败不阻断面板 */ }
  }

  async function refreshGiftStatus() {
    const el = $('giftStatus');
    if (!el) return;
    try {
      const r = await queryContract({ sanguo_gift_status: { player: state.wallet.address, with: null } });
      const ageDays = Math.floor(r.account_age_secs / 86400);
      el.innerHTML = `
        <div class="kv"><span class="k">${t('gift_acct_age')}</span><span class="v">${ageDays}d ${r.banned ? '⛔' : ''}</span></div>
        <div class="kv"><span class="k">${t('gift_pair_ok')}</span><span class="v">${r.pair_ok ? '✅' : '⛔'}</span></div>
        <div class="kv"><span class="k">${t('gift_sent_today')}</span><span class="v">${r.sent_today}/${r.daily_sent_limit}</span></div>
        <div class="kv"><span class="k">${t('gift_recv_today')}</span><span class="v">${r.recv_today}/${r.daily_recv_limit}</span></div>
        <div class="kv"><span class="k">${t('gift_hold')}</span><span class="v">${Math.floor(r.holding_secs / 86400)}d / ${Math.floor(r.legend_holding_secs / 86400)}d</span></div>`;
    } catch (e) {
      el.textContent = t('gift_status_err');
    }
  }

  async function doGift() {
    const to = ($('giftTo').value || '').trim();
    if (!to) { showToast(t('gift_select_to'), 'error'); return; }
    if (!to.startsWith('paxi1')) { showToast(t('gift_invalid_addr'), 'error'); return; }
    const kind = (document.querySelector('input[name="giftKind"]:checked') || {}).value || 'card';
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    let variant, fields, extra, action;
    if (kind === 'card') {
      const cardId = $('giftCard').value;
      if (!cardId) { showToast(t('gift_no_card'), 'error'); return; }
      variant = 'SanguoGiftCard'; action = 'gift_card';
      fields = { card_id: cardId, to };
      extra = `${to}:card:${cardId}`;
    } else if (kind === 'frag') {
      const rarity = $('giftRarity').value;
      const amount = Number($('giftAmount').value || '0');
      if (!amount || amount <= 0) { showToast(t('gift_amount_err'), 'error'); return; }
      variant = 'SanguoGiftFragments'; action = 'gift_fragments';
      fields = { rarity, amount, to };
      extra = `${to}:frag:${rarity}:${amount}`;
    } else {
      const skinId = $('giftSkin').value;
      if (!skinId) { showToast(t('gift_no_skin'), 'error'); return; }
      variant = 'SanguoGiftSkin'; action = 'gift_skin';
      fields = { skin_id: skinId, to };
      extra = `${to}:skin:${skinId}`;
    }
    const btn = $('giftBtn');
    if (btn) btn.disabled = true;
    try {
      await sanguoExec(variant, fields, { action, extra });
      showToast(t('gift_ok'), 'success');
      await refreshGiftStatus();
    } catch (e) {
      showToast(t('gift_fail') + (e.message || e), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.onGiftKindChange = onGiftKindChange;
  window.doGift = doGift;

  // ============================================================
  // 收入对账（仅管理员可见）：逐笔解析 11 个抽水地址的抽卡 wasm 事件，
  // 显示每个地址真实收到的 PAXI + TKCC（链上为准，不受钱包/Ping.pub 的 PRC-20 解析错误影响）。
  // 注：RPC(tx_search) 在手机钱包内置浏览器可能受限（CORS/端口），失败则降级显示「—」
  //     并提示用桌面浏览器查看；当前余额走 LCD 始终可用。
  // ============================================================
  async function rpcSearchAll(query) {
    const base = NETWORK.rpc + '/tx_search';
    const out = [];
    for (let page = 1; page <= 30; page++) {
      const url = `${base}?query=${encodeURIComponent('"' + query + '"')}&order_by="desc"&page=${page}&per_page=50`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('RPC ' + r.status);
      const d = await r.json();
      const txs = (d && d.result && d.result.txs) || [];
      out.push(...txs);
      const total = Number((d && d.result && d.result.total_count) || 0);
      if (!txs.length || out.length >= total) break;
    }
    return out;
  }

  // 解析一笔抽卡交易事件：仅统计「游戏合约发出」的 TKCC 转账/销毁与 PAXI 原生转账
  function parseDrawTx(evs, gameAddr, tkccAddr) {
    let paxi = 0n, tkcc = 0n, burn = 0n, isDraw = false;
    const byType = {};
    for (const e of evs || []) { (byType[e.type] = byType[e.type] || []).push(e); }
    for (const e of (byType.wasm || [])) {
      const kv = {}; for (const a of e.attributes) kv[a.key] = a.value;
      if (kv.action === 'draw_pack' || kv.action === 'draw_pack3') isDraw = true;
    }
    if (!isDraw) return null;
    for (const e of (byType.wasm || [])) {
      const kv = {}; for (const a of e.attributes) kv[a.key] = a.value;
      if (kv._contract_address === tkccAddr && kv.from === gameAddr) {
        if (kv.action === 'transfer') { try { tkcc += BigInt(kv.amount || '0'); } catch (_) {} }
        if (kv.action === 'burn') { try { burn += BigInt(kv.amount || '0'); } catch (_) {} }
      }
    }
    for (const e of (byType.transfer || [])) {
      const kv = {}; for (const a of e.attributes) kv[a.key] = a.value;
      if (kv.sender === gameAddr && kv.amount && kv.amount.endsWith('upaxi')) {
        try { paxi += BigInt(kv.amount.replace('upaxi', '')); } catch (_) {}
      }
    }
    return { paxi, tkcc, burn };
  }

  async function loadLedger() {
    const body = $('sgLedgerBody');
    const hint = $('sgLedgerHint');
    if (hint) hint.textContent = t('ledger_loading');
    if (body) body.innerHTML = `<div class="hint">${t('ledger_scanning')}</div>`;

    const gameAddr = CONTRACTS.game;
    const tkccAddr = CONTRACTS.tkcc;
    let taps = [];
    try {
      const c = await queryContract({ sanguo_config: {} });
      taps = (c && Array.isArray(c.tap_addresses)) ? c.tap_addresses : [];
    } catch (e) { taps = []; }

    const agg = taps.map((addr) => ({ addr, paxi: 0n, tkcc: 0n, count: 0 }));
    let burnTotal = 0n, scanOk = false;
    try {
      for (let i = 0; i < taps.length; i++) {
        const txs = await rpcSearchAll(`wasm.to='${taps[i]}'`);
        for (const tx of txs) {
          const evs = (tx.tx_result && tx.tx_result.events) || tx.events || [];
          const r = parseDrawTx(evs, gameAddr, tkccAddr);
          if (r) { agg[i].paxi += r.paxi; agg[i].tkcc += r.tkcc; agg[i].count += 1; burnTotal += r.burn; }
        }
      }
      scanOk = true;
    } catch (e) {
      if (hint) hint.textContent = t('ledger_rpc_limited');
    }

    if (!body) return;
    let rows = '', sumP = 0n, sumT = 0n;
    for (const a of agg) { sumP += a.paxi; sumT += a.tkcc;
      rows += `<tr>
        <td style="font-size:10px;word-break:break-all;max-width:140px">${a.addr}</td>
        <td style="text-align:center">${a.count}</td>
        <td>${scanOk ? fromRawUnits(a.paxi.toString()) : '—'}</td>
        <td>${scanOk ? fromRawUnits(a.tkcc.toString()) : '—'}</td>
      </tr>`;
    }
    body.innerHTML = `
      <div class="card">
        <div class="desc">${scanOk ? t('ledger_scan_ok') : t('ledger_scan_fail')}</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px">
          <thead><tr style="text-align:left;color:#ffd700">
            <th>${t('ledger_th_addr')}</th><th style="text-align:center">${t('ledger_th_count')}</th><th>${t('ledger_th_paxi')}</th><th>${t('ledger_th_tkcc')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          ${scanOk ? `<tfoot><tr style="font-weight:bold;border-top:1px solid #b8860b">
            <td>${t('ledger_total')}</td><td></td>
            <td>${fromRawUnits(sumP.toString())}</td>
            <td>${fromRawUnits(sumT.toString())}</td>
          </tr></tfoot>` : ''}
        </table>
      </div>
      ${scanOk ? `<div class="card"><div class="kv"><span class="k">${t('ledger_total_burn')}</span><span class="v" style="color:#ff8c69">${fromRawUnits(burnTotal.toString())}</span></div>
        <div class="desc">${t('ledger_burn_desc')}</div></div>` : ''}
      <div class="hint" style="margin-top:8px">${t('ledger_wallet_note')}</div>`;
    if (hint && scanOk) hint.textContent = tf('ledger_done', { n: taps.length });
  }

  async function renderLedger(body) {
    if (!isSgAdmin()) {
      body.innerHTML = `<div class="hint err">${t('ledger_admin_only')}</div>`;
      return;
    }
    body.innerHTML = `
      <div class="card">
        <div class="card-title">${t('ledger_title')}</div>
        <div class="desc">${tf('ledger_desc', { n: 11 })}</div>
      </div>
      <div class="card">
        <button class="btn btn-primary" id="sgLedgerRefresh">${t('ledger_refresh')}</button>
        <span id="sgLedgerHint" class="hint"></span>
      </div>
      <div id="sgLedgerBody">${t('ledger_hint_click')}</div>`;
    const btn = $('sgLedgerRefresh');
    if (btn) btn.onclick = () => loadLedger();
    loadLedger();
  }

  // ============================================================
  // 抽卡
  // ============================================================
  async function renderDraw(body) {
    const cp = await loadCompliance();
    // 🟢 对应审计：SanguoComplianceResponse 已删 compliance_mode 字段（C1 总闸恒真），
    //    查询成功即代表合规版合约 → 免费抽卡入口直接可用
    const isFree = !!cp;
    const limit = isFree ? Number(cp.daily_draw_limit || 0) : 3; // 预览模式默认显示每日 3 次
    body.innerHTML = `
      <div class="card">
        <div class="card-title">🎴 ${t('draw_free_title')}</div>
        <div class="desc">${t('draw_free_desc')}</div>
      </div>
      ${isFree ? `
      <div class="card">
        <div class="kv"><span class="k">${t('draw_remaining')}</span><span class="v" id="sgDrawLeft" style="color:#ffd700">—</span></div>
      </div>` : `
      <div class="card" style="border-color:#c0392b;background:rgba(192,57,43,0.08)">
        <div class="desc" style="color:#ffb3b3">${t('draw_not_migrated')}</div>
      </div>`}
      <div class="card">
        <div class="card-title">${t('draw_single_title')}</div>
        <div class="desc" id="sgDesc1">${t('draw_free_desc')}</div>
        <button class="btn btn-primary" id="sgDraw1" style="margin-top:10px" ${isFree ? '' : 'disabled'}>${t('draw_single')}</button>
      </div>
      <div class="card">
        <div class="card-title">${t('draw_pack3_title')}</div>
        <div class="desc" id="sgDesc3">${tf('shop_frags', { n: 3 })}</div>
        <button class="btn btn-gold" id="sgDraw3" style="margin-top:10px" ${isFree ? '' : 'disabled'}>${t('draw_pack3')}</button>
      </div>
      <div id="sgDrawLog"></div>`;

    await loadParams();
    if (isFree) {
      // 合规版：免费抽卡，展示每日剩余次数（本地计数，合约 SanguoDrawLimitReached 兜底）
      const dayKey = 'sg_free_draws_' + new Date().toISOString().slice(0, 10);
      const used = Number(localStorage.getItem(dayKey) || 0);
      const el = $('sgDrawLeft');
      if (el) el.textContent = Math.max(0, limit - used) + ' / ' + limit;
      const disable = limit > 0 && used >= limit;
      if ($('sgDraw1')) $('sgDraw1').disabled = disable;
      if ($('sgDraw3')) $('sgDraw3').disabled = disable;
      const d1 = $('sgDesc1'), d3 = $('sgDesc3');
      if (d1) d1.textContent = disable ? t('draw_free_done') : t('draw_free_desc');
      if (d3) d3.textContent = disable ? t('draw_free_done') : tf('shop_frags', { n: 3 });
    }
    // 未迁移（isFree=false）时按钮保持 disabled，仅作界面预览，不会发交易。

    $('sgDraw1').onclick = () => doDraw(false);
    $('sgDraw3').onclick = () => doDraw(true);
  }

  async function doDraw(pack3) {
    try {
      await requireSanguo();
    } catch (e) { showToast(e.message, 'error'); return; }

    // 🟢 合规分支：免费抽卡 —— 不查 tap / TKCC / 内部 PAXI，直接发交易（合约 billed=0）
    const cp = await loadCompliance();
    if (cp) {
      showBusy(t('draw_doing'));
      try {
        await sanguoExec('SanguoDraw', { tap_index: 0, pack3 }, {
          action: pack3 ? 'draw_pack3' : 'draw_pack',
          spend: 0,
        });
        await loadSanguoCards();
        sgJustDrew = true;
        showToast(t('draw_ok_short'), 'success');
        // 更新本地剩余次数
        const dayKey = 'sg_free_draws_' + new Date().toISOString().slice(0, 10);
        const limit = Number(cp.daily_draw_limit || 0);
        const used = Number(localStorage.getItem(dayKey) || 0) + (pack3 ? 3 : 1);
        localStorage.setItem(dayKey, String(used));
        if (sanguoTab === 'draw') renderSanguoTab();
        else if (sanguoTab === 'mycards') renderSanguoTab();
      } catch (e) {
        const log = $('sgDrawLog');
        if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
        showToast(t('draw_fail') + (e.message || e), 'error');
      } finally { hideBusy(); }
      return;
    }

    // 🟢 外部审计 #12 修复：删除 TKCC/PAXI 计费 fallback 分支——
    //    合规版抽卡恒免费（合约 deprecated 计费字段不读取、spend=0），
    //    即使 sanguo_compliance 查询失败也不允许走任何计费路径。
    showBusy(t('draw_doing'));
    try {
      await sanguoExec('SanguoDraw', { tap_index: 0, pack3 }, {
        action: pack3 ? 'draw_pack3' : 'draw_pack',
        spend: 0,
      });
      await loadSanguoCards();
      sgJustDrew = true;
      showToast(t('draw_ok_short'), 'success');
      if (sanguoTab === 'draw') renderSanguoTab();
      else if (sanguoTab === 'mycards') renderSanguoTab();
    } catch (e) {
      const log = $('sgDrawLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('draw_fail') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // ============================================================
  // 🆕 商店（买卡 + 买碎片）：明码标价、付钱即得（合规模式允许的确定性购买）
  //    付款双通道：tx 附带 funds 优先，缺口合约自动从内部 PAXI 余额扣
  //    → 前端附加 funds = 全额价格，内部余额不足时由合约报 SanguoInsufficientPayment
  // ============================================================
  let sgCardPrices = null;    // { prices: [[name, priceStr], ...] }
  let sgFragPrices = null;    // { prices: [[rarity, count, priceStr], ...] }

  async function renderShop(body) {
    body.innerHTML = `
      <div class="card">
        <div class="card-title">${t('shop_title')}</div>
        <div class="desc">${t('shop_desc')}</div>
      </div>
      <div id="sgShopBody">${sgSkeletonProducts(6)}</div>`;

    // 🟢 7A：拉取链上支付币种 / 养成常量，供支付提示与手续费展示
    try { await loadParams(); } catch (e) {}

    if (!state.wallet) {
      $('sgShopBody').innerHTML = `<div class="hint err">${t('connect_first')}</div>`;
      return;
    }
    try {
      const [cp, fp] = await Promise.all([
        queryContract({ sanguo_card_prices: {} }).catch(() => null),
        queryContract({ sanguo_fragment_prices: {} }).catch(() => null),
      ]);
      sgCardPrices = cp; sgFragPrices = fp;
    } catch (e) { sgCardPrices = null; sgFragPrices = null; }

    // 🆕 新玩法查询：体力 / 皮肤 / 赛季（任一失败不阻断整页）
    let sgStamina = null, sgSkins = [], sgPlayerSkins = [], sgSeason = null, sgPlayerSeason = null;
    if (state.wallet) {
      try {
        const [st, sk, psk, se, pse] = await Promise.all([
          queryContract({ sanguo_stamina: { address: state.wallet.address } }).catch(() => null),
          queryContract({ sanguo_skins: {} }).catch(() => null),
          queryContract({ sanguo_player_skins: { address: state.wallet.address } }).catch(() => null),
          queryContract({ sanguo_season: {} }).catch(() => null),
          queryContract({ sanguo_player_season: { address: state.wallet.address } }).catch(() => null),
        ]);
        sgStamina = st; sgSkins = (sk && sk.skins) || []; sgPlayerSkins = (psk && psk.skins) || [];
        sgSeason = se; sgPlayerSeason = pse;
      } catch (e) { /* 忽略 */ }
    }

    const priceMap = {};
    (sgCardPrices && sgCardPrices.prices || []).forEach(([name, price]) => { priceMap[name] = price; });
    // 🟢 合规化：V2 碎片只产不购，已移除购买入口（SanguoBuyFragments 已从合约删除）

    // 卡牌商店：按模板列表渲染（有价的才可买）
    const tplList = await loadSanguoTemplates();
    const cardRows = tplList.map((tp) => {
      const price = priceMap[tp.name];
      const col = rarityColor(tp.rarity);
      return `<div class="shop-card" style="border-color:${col}">
        ${price ? `<span class="cur-tag">PAXI</span>` : ''}
        <img src="${getCardImage(tp.name)}" alt="${esc(tp.name)}" loading="lazy" decoding="async"
             style="width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:8px;margin-bottom:4px;background:rgba(255,255,255,.04)"
             onerror="this.style.display='none'">
        <div class="sc-nm">${esc(tp.name)}</div>
        <div class="sc-rr" style="color:${col}">${rarityLabel(tp.rarity)}</div>
        <div class="sc-price">${price ? fromRawUnits(price) + ' PAXI' : t('shop_price_na')}</div>
        ${price ? `<button class="btn btn-sm btn-gold" data-buy="${esc(tp.name)}" data-price="${price}">${t('shop_buy')}</button>` : ''}
      </div>`;
    }).join('');

    // 🟢 合规化：V2 碎片只产不购，已移除购买入口（SanguoBuyFragments 已从合约删除）

    const payHint = `<div class="hint" style="margin-bottom:8px">💳 当前支付币种：<b>${esc(currentPayLabel())}</b>${(paramsCache && paramsCache.pay_token) ? '（PRC-20 内部余额，请先充值该代币）' : ''}</div>`;
    $('sgShopBody').innerHTML = `
      ${payHint}
      <div class="card">
        <div class="card-title">${t('shop_cards')}</div>
        <div class="shop-grid">${cardRows}</div>
      </div>

      <!-- 🆕 体力（PAXI 明码标价，确定获得） -->
      <div class="card" style="border-color:#22c55e">
        <div class="card-title">🔋 ${t('shop_stamina')}</div>
        <div class="desc">${t('shop_stamina_desc')}</div>
        <div class="kv"><span class="k">${t('shop_stamina_now')}</span><span class="v" id="sgStaminaNow">${sgStamina ? (sgStamina.current + ' / ' + sgStamina.max) : '—'}</span></div>
        <div class="kv" style="align-items:center;margin-top:8px">
          <span class="k">${t('shop_stamina_buy')}</span>
          <span class="v">
            <select id="sgStaminaPacks" class="input" style="width:auto;display:inline-block;padding:2px 6px;margin-right:8px">
              ${[1, 5, 10].map((n) => `<option value="${n}">${n} ${t('shop_packs')}</option>`).join('')}
            </select>
            <button class="btn btn-sm btn-gold" id="sgBuyStamina">${t('shop_buy')} · <span id="sgStaminaCost">${fromRawUnits(String(staminaPackPriceUpaxi()))}</span> PAXI</button>
          </span>
        </div>
      </div>

      <!-- 🆕 皮肤（纯外观，PAXI 购买，不可转让） -->
      <div class="card" style="border-color:#a78bfa">
        <div class="card-title">🎨 ${t('shop_skins')}</div>
        <div class="desc">${t('shop_skins_desc')}</div>
        <div id="sgSkinList" style="margin-top:8px">
          ${sgSkins.length ? sgSkins.map((s) => {
            const owned = sgPlayerSkins.includes(s.id);
            const col = rarityColor(s.rarity);
            return `<div class="kv" style="align-items:center">
              <img src="${getSkinImage(s.id)}" style="width:42px;height:63px;object-fit:cover;border-radius:6px;margin-right:8px;vertical-align:middle" onerror="this.style.display='none'">
              <span class="k" style="color:${col}">${esc(s.name)}<br><span style="font-size:9px;color:#9fb3d1">${rarityLabel(s.rarity)}</span></span>
              <span class="v">
                ${owned ? `<span style="color:#22c55e">${t('shop_skin_owned')}</span>` : `<button class="btn btn-sm btn-gold" data-skin="${esc(s.id)}" data-price="${s.price_paxi}">${t('shop_skin_buy')} · ${fromRawUnits(s.price_paxi)} PAXI</button>`}
              </span>
            </div>`;
          }).join('') : `<div class="hint">${t('shop_season_inactive')}</div>`}
        </div>
      </div>

      <!-- 🆕 赛季通行证（PAXI 购买，按点数领碎片） -->
      <div class="card" style="border-color:#fbbf24">
        <div class="card-title">🏆 ${t('shop_season')}</div>
        <div class="desc">${t('shop_season_desc')}</div>
        ${sgSeason && sgSeason.active ? `
          <div class="kv"><span class="k">${t('shop_season_pass_price')}</span><span class="v" style="color:#ffd700">${fromRawUnits(sgSeason.pass_price_paxi)} PAXI</span></div>
          <div class="kv"><span class="k">${t('shop_season_points')}</span><span class="v" id="sgSeasonPts">${sgPlayerSeason ? sgPlayerSeason.points : 0}</span></div>
          <div style="margin-top:8px">
            ${sgPlayerSeason && sgPlayerSeason.pass_owned ? `<span style="color:#22c55e">${t('shop_season_owned')}</span>` : `<button class="btn btn-sm btn-gold" id="sgBuySeason">${t('shop_season_buy')}</button>`}
          </div>
          <div id="sgSeasonTiers" style="margin-top:8px">
            ${(sgSeason.tiers || []).map((ti, i) => {
              // 二次审计 Med：合约 claimed 是 Vec<u64>（JSON 数字），统一转数字比较
              const claimedArr = (sgPlayerSeason && sgPlayerSeason.claimed || []).map(Number);
              const claimed = claimedArr.includes(i);
              const reached = sgPlayerSeason && sgPlayerSeason.pass_owned && (sgPlayerSeason.points >= ti.points_req);
              const total = Number(ti.reward.common || 0) + Number(ti.reward.rare || 0) + Number(ti.reward.epic || 0) + Number(ti.reward.legend || 0);
              return `<div class="kv" style="align-items:center">
                <span class="k">T${i + 1} · ${ti.points_req}pt<br><span style="font-size:9px;color:#ffd700">🧩${total}</span></span>
                <span class="v">
                  ${claimed ? `<span style="color:#22c55e">${t('shop_season_tier_claimed')}</span>` : reached ? `<button class="btn btn-sm btn-gold" data-tier="${i}">${t('shop_season_tier_claim')}</button>` : `<span style="color:#9fb3d1">${t('shop_season_tier_locked')}</span>`}
                </span>
              </div>`;
            }).join('')}
          </div>
        ` : `<div class="hint" style="margin-top:8px">${t('shop_season_inactive')}</div>`}
      </div>

      <div id="sgShopLog"></div>`;

    // 买卡
    $('sgShopBody').querySelectorAll('button[data-buy]').forEach((b) => {
      b.onclick = () => doBuyCard(b.dataset.buy, b.dataset.price);
    });

    // 🆕 体力包数联动总价
    const stSel = $('sgStaminaPacks');
    if (stSel) {
      const updSt = () => {
        const tot = staminaPackPriceUpaxi() * Number(stSel.value || 1);
        const cEl = $('sgStaminaCost');
        if (cEl) cEl.textContent = fromRawUnits(String(tot));
      };
      stSel.onchange = updSt; updSt();
    }
    const bSt = $('sgBuyStamina');
    if (bSt) bSt.onclick = () => doBuyStamina(Number((stSel && stSel.value) || 1));
    // 🆕 皮肤购买
    $('sgShopBody').querySelectorAll('button[data-skin]').forEach((b) => {
      b.onclick = () => doBuySkin(b.dataset.skin, b.dataset.price);
    });
    // 🆕 购买赛季通行证
    const bSp = $('sgBuySeason');
    if (bSp) bSp.onclick = () => doBuySeasonPass();
    // 🆕 领取赛季层级奖励
    $('sgShopBody').querySelectorAll('button[data-tier]').forEach((b) => {
      b.onclick = () => doClaimSeasonTier(Number(b.dataset.tier));
    });
  }

  async function doBuyCard(cardName, priceStr) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('shop_buying'));
    try {
      await sanguoExec('SanguoBuyCard', { card_name: cardName }, {
        action: 'buy_card',
        spend: String(priceStr),   // 🟢 全盘审计：用字符串签名，避免 Number() 大额精度丢失导致验签失败
        funds: paymentFunds(priceStr),
      });
      await loadSanguoCards();
      await refreshBalances();
      showToast(tf('shop_card_ok', { name: cardName }), 'success');
      const log = $('sgShopLog');
      if (log) log.innerHTML = `<div class="hint ok">✅ ${tf('shop_card_ok', { name: cardName })}</div>`;
    } catch (e) {
      const log = $('sgShopLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('shop_fail') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // 🟢 合规化：doBuyFragments 已移除——V2 碎片只产不购（SanguoBuyFragments 入口已从合约删除），
  //    碎片唯一来源：AI/PVP/混战/关卡/每日任务/赛季奖励。

  // ============================================================
  // 🆕 商店动作：体力 / 皮肤 / 赛季通行证（均走 sanguo_auth 无感验签）
  // ============================================================
  async function doBuyStamina(packCount) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    const price = BigInt(staminaPackPriceUpaxi()) * BigInt(packCount || 1);
    showBusy(t('shop_buying'));
    try {
      await sanguoExec('SanguoBuyStamina', { pack_count: packCount || 1 }, {
        action: 'buy_stamina',
        spend: String(price),   // 🟢 全盘审计：字符串签名防精度丢失
        funds: paymentFunds(price.toString()),
      });
      await refreshBalances();
      showToast(t('shop_ok'), 'success');
      renderSanguoTab();
    } catch (e) {
      const log = $('sgShopLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('shop_fail') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  async function doBuySkin(skinId, priceStr) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('shop_buying'));
    try {
      await sanguoExec('SanguoBuySkin', { skin_id: skinId }, {
        action: 'buy_skin',
        spend: String(priceStr),   // 🟢 全盘审计：字符串签名防精度丢失
        funds: paymentFunds(priceStr),
      });
      showToast(t('shop_ok'), 'success');
      renderSanguoTab();
    } catch (e) {
      const log = $('sgShopLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('shop_fail') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  async function doBuySeasonPass() {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    // 二次审计 High-B 修复：合约验签 spend = pass_price_paxi，前端必须按同一价格签 spend 并附 funds。
    // 🟢 全盘审计：改用字符串，避免 Number() 大额精度丢失导致验签失败
    const priceStr = String((sgSeason && sgSeason.pass_price_paxi) || '0');
    if (!priceStr || priceStr === '0') { showToast(t('shop_season_inactive'), 'error'); return; }
    showBusy(t('shop_buying'));
    try {
      await sanguoExec('SanguoBuySeasonPass', {}, {
        action: 'buy_season_pass',
        spend: priceStr,
        funds: paymentFunds(priceStr),
      });
      showToast(t('shop_ok'), 'success');
      renderSanguoTab();
    } catch (e) {
      const log = $('sgShopLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('shop_fail') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  async function doClaimSeasonTier(tierIndex) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoClaimSeasonTier', { tier_index: tierIndex }, {
        action: 'claim_season_tier',
        spend: 0,
        funds: [],
      });
      showToast(t('ok_short'), 'success');
      renderSanguoTab();
    } catch (e) {
      const log = $('sgShopLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('fail_prefix') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // ============================================================
  // 🆕 天梯排位：消耗 10 体力，确定性 9v9 复算 vs 同档 AI，胜利得碎片 + 赛季点
  // ============================================================
  async function renderRanked(body) {
    if (state.wallet) await loadSanguoCards();
    sanguoPicked = [];
    body.innerHTML = `
      <div class="card">
        <div class="card-title">${t('ranked_title')}</div>
        <div class="desc">${t('ranked_desc')}</div>
      </div>
      <div id="sgRankInfo"></div>
      <div class="card">
        <div class="card-title">${t('ranked_pick')}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0" id="sgRankPick"></div>
        <div class="hint">${userCards.length >= 9 ? '' : `⚠️ ${userCards.length} / 9 · ${t('ranked_need9')}`}</div>
      </div>
      <div id="sgRankLog"></div>`;

    let rank = null, stamina = null;
    if (state.wallet) {
      try { rank = await queryContract({ sanguo_rank: { address: state.wallet.address } }); } catch (e) {}
      try { stamina = await queryContract({ sanguo_stamina: { address: state.wallet.address } }); } catch (e) {}
    }
    const infoEl = $('sgRankInfo');
    if (infoEl) {
      const tier = rank ? rank.tier : 0;
      const pts = rank ? rank.points : 0;
      const st = stamina ? (stamina.current + ' / ' + stamina.max) : '—';
      infoEl.innerHTML = `
        <div class="card rank-tier-card">
          <div class="kv"><span class="k">${t('ranked_tier')}</span><span class="v" style="color:#ffd700">T${tier + 1}</span></div>
          <div class="kv"><span class="k">${t('ranked_points')}</span><span class="v">${pts}</span></div>
          <div class="kv"><span class="k">${t('ranked_cost')}</span><span class="v">10</span></div>
          <div class="kv"><span class="k">🔋 ${t('shop_stamina_now')}</span><span class="v">${st}</span></div>
          <button class="btn btn-primary" id="sgRankStart" style="margin-top:8px;width:100%">${t('ranked_start')}</button>
        </div>`;
      const startBtn = $('sgRankStart');
      if (startBtn) startBtn.onclick = () => doRankedBattle(tier);
    }
    if (state.wallet && userCards.length) {
      try {
        const bo = await queryContract({ sanguo_battle_order: { player: state.wallet.address } });
        if (bo && bo.order && bo.order.length) {
          const ids = bo.order.filter((id) => userCards.some((c) => c.card_id === id)).slice(0, 9);
          if (ids.length) sanguoPicked = ids;
        }
      } catch (e) {}
    }
    sanguoRenderPicker('sgRankPick', 9);
  }

  async function doRankedBattle(tier) {
    if (sanguoPicked.length !== 9) { showToast(t('ranked_need9'), 'error'); return; }
    if (!sgTeamCostOk(sanguoPicked.slice())) return;
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      const r = await sanguoExec('SanguoBattleAi', {
        mode: 'ranked',
        level: tier,
        card_ids: sanguoPicked.slice(),
      }, { action: 'battle_ai', spend: 0, extra: 'ranked:battle:' + tier });
      const ev = parseTxEvents(r.tx, ['won', 'reward_total']);
      const won = ev.won && ev.won[0] === 'true';
      const total = (ev.reward_total && ev.reward_total[0]) ? Number(ev.reward_total[0]) : 0;
      if (won) showToast(tf('ranked_won', { n: total }), 'success');
      else showToast(t('ranked_lose'), 'error');
      renderSanguoTab();
    } catch (e) {
      const log = $('sgRankLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('fail_prefix') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // ============================================================
  // 🆕 每日任务：完成任务领碎片 + 赛季点，每玩家每日每任务一次（UTC 日重置）
  // ============================================================
  async function renderDailyTask(body) {
    body.innerHTML = `
      <div class="card">
        <div class="card-title">${t('dailytask_title')}</div>
        <div class="desc">${t('dailytask_desc')}</div>
      </div>
      <div id="sgDailyList"><div class="hint">${t('loading')}</div></div>`;
    if (!state.wallet) {
      $('sgDailyList').innerHTML = `<div class="hint err">${t('connect_first')}</div>`;
      return;
    }
    let tasks = [];
    try {
      const r = await queryContract({ sanguo_daily_task: { address: state.wallet.address } });
      tasks = (r && r.tasks) || [];
    } catch (e) { tasks = []; }
    const DTASK_LABELS = [t('dtask_0'), t('dtask_1'), t('dtask_2'), t('dtask_3')];
    const listEl = $('sgDailyList');
    if (!tasks.length) {
      listEl.innerHTML = `<div class="card"><div class="hint">${t('dailytask_desc')}</div></div>`;
      return;
    }
    listEl.innerHTML = tasks.map((tk, i) => {
      const total = Number(tk.reward.common || 0) + Number(tk.reward.rare || 0) + Number(tk.reward.epic || 0) + Number(tk.reward.legend || 0);
      const done = !!tk.claimed;
      const can = !done && Number(tk.progress) >= Number(tk.required);
      return `<div class="card" style="border-color:#b8860b">
        <div class="card-title">${DTASK_LABELS[i] || ('#' + tk.task_id)}</div>
        <div class="kv"><span class="k">${t('dailytask_progress')}</span><span class="v">${tk.progress} / ${tk.required}</span></div>
        <div class="kv"><span class="k">${t('dailytask_reward')}</span><span class="v" style="color:#ffd700">🧩${total}</span></div>
        <div style="margin-top:8px">
          ${done ? `<span style="color:#22c55e">${t('dailytask_claimed')}</span>` : can ? `<button class="btn btn-primary" data-dtask="${tk.task_id}" style="width:100%">${t('dailytask_claim')}</button>` : `<span style="color:#9fb3d1">${t('dailytask_incomplete')}</span>`}
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('button[data-dtask]').forEach((b) => {
      b.onclick = () => doClaimDailyTask(Number(b.dataset.dtask));
    });
  }

  async function doClaimDailyTask(taskId) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoClaimDailyTask', { task_id: taskId }, {
        action: 'claim_daily_task',
        spend: 0,
        funds: [],
      });
      showToast(t('ok_short'), 'success');
      renderSanguoTab();
    } catch (e) {
      const log = $('sgDailyList');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('fail_prefix') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // ============================================================
  // 🆕 关卡挑战（PVE）：9 张卡编队，链下打、链上复算，通关发碎片
  // ============================================================
  async function renderStage(body) {
    if (state.wallet) await loadSanguoCards();
    sanguoPicked = [];
    let stages = [];
    try {
      const r = await queryContract({ sanguo_stages: {} });
      stages = (r && r.stages) || [];
    } catch (e) { stages = []; }
    const cleared = {};
    // 已通关信息合约不直接提供列表查询；重复提交会被合约 SanguoAlreadyClaimed 拦截（兜底）

    body.innerHTML = `
      <div class="card">
        <div class="card-title">${t('stage_title')}</div>
        <div class="desc">${t('stage_desc')}</div>
      </div>
      <div class="card">
        <div class="card-title">${t('stage_pick')}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0" id="sgStagePick"></div>
        <div class="hint">${userCards.length >= 9 ? '' : `⚠️ ${userCards.length} / 9 · ${t('stage_need9')}`}</div>
      </div>
      <div id="sgStageList">
        ${stages.length ? '' : `<div class="card"><div class="hint">${t('stage_no_stages')}</div></div>`}
      </div>
      <div id="sgStageLog"></div>`;

    // 关卡列表
    if (stages.length) {
      const listEl = $('sgStageList');
      listEl.innerHTML = stages.map((s) => {
        const rw = s.reward || {};
        const totalFrag = Number(rw.common || 0) + Number(rw.rare || 0) + Number(rw.epic || 0) + Number(rw.legend || 0);
        return `<div class="card" style="border-color:#b8860b">
          <div class="card-title">🗺️ ${esc(s.name || ('Stage #' + s.id))}</div>
          <div class="kv"><span class="k">${t('stage_reward')}</span>
            <span class="v" style="color:#ffd700">
              ${rw.common ? '🟤' + rw.common + ' ' : ''}${rw.rare ? '🔵' + rw.rare + ' ' : ''}${rw.epic ? '🟣' + rw.epic + ' ' : ''}${rw.legend ? '🟡' + rw.legend : ''}
              ${totalFrag ? '' : '—'}
            </span>
          </div>
          <button class="btn btn-primary" data-stage="${s.id}" style="margin-top:8px;width:100%">${t('stage_submit')}</button>
        </div>`;
      }).join('');
      listEl.querySelectorAll('button[data-stage]').forEach((b) => {
        b.onclick = () => doSubmitStage(Number(b.dataset.stage));
      });
    }

    // 编队选择器：9 张
    if (state.wallet && userCards.length) {
      try {
        const bo = await queryContract({ sanguo_battle_order: { player: state.wallet.address } });
        if (bo && bo.order && bo.order.length) {
          const ids = bo.order.filter((id) => userCards.some((c) => c.card_id === id)).slice(0, 9);
          if (ids.length) sanguoPicked = ids;
        }
      } catch (e) {}
    }
    sanguoRenderPicker('sgStagePick', 9);
  }

  async function doSubmitStage(stageId) {
    if (sanguoPicked.length !== 9) {
      showToast(t('stage_need9'), 'error');
      return;
    }
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('stage_submitting'));
    try {
      const batchId = 'stage_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      const res = await sanguoExec('SanguoSubmitStageBatch', {
        stage_id: stageId,
        batch_id: batchId,
        card_ids: sanguoPicked.slice(),
      }, { action: 'submit_stage', spend: 0 });
      showToast(t('stage_ok'), 'success');
      const log = $('sgStageLog');
      // V2.1：技能触发回放（A=我方，B=关卡敌军）
      const sl = (res && res.tx) ? (parseTxEvents(res.tx, ['skill_log']).skill_log || [])[0] : null;
      if (log) {
        log.innerHTML = `<div class="hint ok">✅ ${t('stage_ok')}</div>`;
        if (sl) log.insertAdjacentHTML('beforeend', skillLogTimelineHtml(sl, t('battle_you'), t('battle_opp')));
      }
    } catch (e) {
      const log = $('sgStageLog');
      if (log) log.innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('stage_fail') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // ============================================================
  // 我的卡
  // ============================================================
  async function renderMyCards(body) {
    body.innerHTML = `
      <div class="card" id="sgMigrateCard" style="display:none">
        <div class="card-title">📦 ${t('migrate_title')}</div>
        <div class="desc">${t('migrate_desc')}</div>
        <div class="hint" style="margin-top:6px;color:#e8b04b">${t('migrate_limit_note')}</div>
        <div id="sgMigrateLog"></div>
        <button class="btn btn-primary" id="sgMigrateBtn" style="margin-top:8px">${t('migrate_btn')}</button>
      </div>
      <div class="card" id="sgPendingCard" style="display:none">
        <div class="card-title">🎁 ${t('pending_reward')}（<span id="sgPendingTotal">0</span> TKCC）</div>
        <div id="sgPendingList"></div>
        <button class="btn btn-gold" id="sgClaimAll" style="margin-top:8px">${t('claim_btn')}</button>
      </div>
      <div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          🃏 ${t('my_cards')}（<span id="sgCardCount">0</span>）
          <button class="btn btn-sm ${sgBatchMode ? 'btn-primary' : 'btn-ghost'}" id="sgBatchBtn">${t('batch_decompose')}</button>
        </div>
        <div class="desc">${t('my_cards_desc')}</div>
      </div>
      <div id="sgBatchBar" class="sg-batch-bar" style="display:${sgBatchMode ? 'flex' : 'none'}">
        <span>${t('selected')} <span id="sgBatchCount">${sgBatchSel.size}</span></span>
        <button class="btn btn-sm btn-danger" id="sgBatchDo">${t('batch_decompose_do')}</button>
        <button class="btn btn-sm btn-ghost" id="sgBatchCancel">${t('cancel')}</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px" id="sgCardGrid"></div>`;
    const grid = $('sgCardGrid');
    if (grid && state.wallet) grid.innerHTML = sgSkeletonCards(6);   // 加载骨架屏
    if (state.wallet) await loadSanguoCards();
    $('sgCardCount').textContent = userCards.length;
    if (!userCards.length) {
      grid.innerHTML = `<div class="hub-empty" style="grid-column:1/-1"><span class="ic">🃏</span>${t('empty_cards')}</div>`;
    } else {
      grid.innerHTML = userCards.map((c) => cardHtml(c)).join('');
      sgObserveLazyImages(grid);   // 卡图懒加载
      sgJustDrew = false;   // 翻牌类已写进 HTML，立刻清位，避免下次无关重渲染再翻
    }
    // 批量分解模式绑定（P1-9）
    const bb = $('sgBatchBtn');
    if (bb) bb.onclick = () => { sgBatchMode = !sgBatchMode; if (!sgBatchMode) sgBatchSel.clear(); renderSanguoTab(); };
    const bdo = $('sgBatchDo');
    if (bdo) bdo.onclick = () => sgBatchDecompose();
    const bcancel = $('sgBatchCancel');
    if (bcancel) bcancel.onclick = () => { sgBatchMode = false; sgBatchSel.clear(); renderSanguoTab(); };
    const bcount = $('sgBatchCount');
    if (bcount) bcount.textContent = String(sgBatchSel.size);
    // 老合约资产迁移入口（仅当管理员已放行该老合约时展示）
    renderSanguoMigrationEntry();

    // 待领取奖励（AI 对战胜利后进入待领取队列）
    if (state.wallet) {
      try {
        const pend = await queryContract({ sanguo_pending: { address: state.wallet.address } });
        const ids = (pend && pend.battle_ids) || [];
        const total = (pend && pend.total_rewards) ? pend.total_rewards : '0';
        if (ids.length) {
          $('sgPendingCard').style.display = '';
          $('sgPendingTotal').textContent = fromRawUnits(total);
          $('sgPendingList').innerHTML = ids.map((id) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1c2740">
              <span style="font-size:12px;color:#9fb3d1">${id}</span>
              <button class="btn btn-sm btn-gold" data-bid="${id}">${t('claim_btn')}</button>
            </div>`).join('');
          $('sgPendingList').querySelectorAll('button[data-bid]').forEach((b) => {
            b.onclick = () => doClaimReward(b.dataset.bid);
          });
          $('sgClaimAll').onclick = () => doClaimAll(ids);
        }
      } catch (e) { /* 忽略，不影响卡片展示 */ }
    }
  }

  // ============================================================
  // 老合约资产迁移
  // ============================================================
  // 本会话是否已迁移成功（合约侧每钱包只允许一次，这里只是省掉一次必然失败的 tx）
  let migrationDone = false;
  // 预览阶段读到的老合约卡数（null = 未知）；用于算 gas 上限，真正发交易前还会再核一次
  let oldMigrateCardCount = null;

  // ============================================================
  // 迁移容量 / gas 预算（链上实测校准，2026-09-20）
  //   实测：迁 3 张 = 454,173 gas；迁 3 张（另一钱包）= 454,186 gas
  //   拟合：gas(N) ≈ 364,000 + 30,000 × N   （N=3 代入得 454k，与实测吻合）
  //   固定开销 ≈ 36 万（白名单读 + secp256k1 验签 + 2 次跨合约 query 实例化老合约 VM）
  //   每张卡 ≈ 3 万（2 读：MIGRATED_CARDS / CARD_ID_COUNTER；3 写：COUNTER / CARDS / MIGRATED_CARDS）
  // → 600k 只能迁约 8 张；30 张约需 126~156 万；故单次上限定 30 张 + gas 按卡数自适应。
  // ============================================================
  const MIGRATE_MAX_CARDS = 30;          // 单次迁移卡数上限（超了先去老合约分解）
  const MIGRATE_GAS_BASE = 400_000;      // 固定开销（实测 36 万，取 40 万留余量）
  const MIGRATE_GAS_PER_CARD = 60_000;   // 每张卡（实测约 3 万，取 6 万 = 2 倍冗余）
  const MIGRATE_GAS_MIN = 600_000;       // 与其余玩法一致的下限
  const MIGRATE_GAS_MAX = 3_000_000;     // 30 张 → 400k + 60k×30 = 220 万，封顶 300 万
  // 卡数未知（预览查询失败）时按满额 30 张准备 → 220 万，不会爆
  const MIGRATE_GAS_UNKNOWN = MIGRATE_GAS_BASE + MIGRATE_GAS_PER_CARD * MIGRATE_MAX_CARDS;

  /** 按老合约卡数算本次迁移的 gas 上限（clamp 在 [MIN, MAX]） */
  function migrationGasLimit(cardCount) {
    // ⚠️ 必须先判 null/undefined：Number(null) === 0，会误判成"0 张卡"只给 60 万
    if (cardCount == null) return Math.min(MIGRATE_GAS_MAX, MIGRATE_GAS_UNKNOWN);
    const n = Number(cardCount);
    if (!Number.isFinite(n) || n < 0) return Math.min(MIGRATE_GAS_MAX, MIGRATE_GAS_UNKNOWN);
    return Math.min(MIGRATE_GAS_MAX, Math.max(MIGRATE_GAS_MIN, MIGRATE_GAS_BASE + MIGRATE_GAS_PER_CARD * n));
  }

  /** 读老合约当前钱包的卡数；失败返回 null（不阻断，按满额准备 gas） */
  async function fetchOldCardCount() {
    if (!state.wallet) return null;
    try {
      const cards = await queryAnyContract(OLD_SANGUO_CONTRACT, { player_cards: { address: state.wallet.address } });
      return (cards && cards.cards) ? cards.cards.length : 0;
    } catch (e) {
      return null;
    }
  }

  /**
   * 渲染「一键迁移」入口。
   *
   * 🟢 2026-09-29 起永久隐藏：所有玩家均已迁移完成（函数入口直接 return）。
   *
   * 原展示条件（三者都满足才显示）：
   *   1. 已连接钱包；
   *   2. 本会话还没迁移过；
   *   3. 新合约的迁移白名单里包含 OLD_SANGUO_CONTRACT。
   *
   * 同时直连老合约做一次只读预览（卡牌数 + 碎片数），让玩家在点按钮前
   * 就知道能搬过来什么。预览失败不影响入口展示（老合约可能暂时不可达）。
   */
  async function renderSanguoMigrationEntry() {
    // 🟢 2026-09-29：所有玩家均已迁移完成，迁移入口永久隐藏（卡片默认 display:none）。
    //    需要恢复时：删除下面这行 return 即可，原展示逻辑保持不动。
    return;
    const card = $('sgMigrateCard');
    if (!card) return;
    if (!state.wallet || migrationDone) return;

    try {
      const wl = await queryContract({ sanguo_migration_whitelist: {} });
      const list = (wl && wl.contracts) || [];
      if (!list.includes(OLD_SANGUO_CONTRACT)) return;   // 管理员未放行 → 不展示
    } catch (e) {
      return; // 查询失败（网络/合约未部署该查询）→ 宁可不展示，也不要误导
    }

    card.style.display = '';

    const log = $('sgMigrateLog');
    const btn = $('sgMigrateBtn');
    btn.onclick = doMigrateFromOld;

    try {
      const [cards, frags] = await Promise.all([
        queryAnyContract(OLD_SANGUO_CONTRACT, { player_cards: { address: state.wallet.address } }),
        queryAnyContract(OLD_SANGUO_CONTRACT, { get_fragments: { address: state.wallet.address } }),
      ]);
      const n = (cards && cards.cards) ? cards.cards.length : 0;
      const fg = (frags && (frags.common || frags.rare || frags.epic || frags.legend))
        ? `${frags.common || 0}/${frags.rare || 0}/${frags.epic || 0}/${frags.legend || 0}`
        : '0/0/0/0';
      oldMigrateCardCount = n;
      log.innerHTML = `<div class="hint" style="margin-top:6px">${tf('migrate_old_summary', { n: esc(n), fg: esc(fg) })}</div>`;
      if (n === 0 && fg === '0/0/0/0') {
        btn.disabled = true;
        log.innerHTML += `<div class="hint" style="margin-top:4px">${t('migrate_none')}</div>`;
      } else if (n > MIGRATE_MAX_CARDS) {
        // 🟢 超出单次 gas 容量：直接拦下，避免玩家点了必然 out of gas 的交易（手续费白扣）
        btn.disabled = true;
        btn.textContent = t('migrate_blocked');
        log.innerHTML += `<div class="hint err" style="margin-top:4px">⚠️ ${esc(tf('migrate_over_limit', { n, max: MIGRATE_MAX_CARDS, over: n - MIGRATE_MAX_CARDS }))}</div>`;
      } else {
        log.innerHTML += `<div class="hint" style="margin-top:4px">${esc(tf('migrate_gas_hint', { n, gas: migrationGasLimit(n).toLocaleString('en-US') }))}</div>`;
      }
    } catch (e) {
      // 预览失败：不阻断按钮，但提示已按满额准备 gas
      log.innerHTML += `<div class="hint" style="margin-top:4px">${esc(tf('migrate_no_preview', { max: MIGRATE_MAX_CARDS }))}</div>`;
    }
  }

  /**
   * 一键迁移：把老合约里的卡（保留稀有度/攻防/星级/等级）与 4 档碎片搬过来。
   *
   * ⚠️ action 必须是 'migrate'（合约 sanguo_auth 的 action 参数），spend 必须是 0，
   *    两者都参与签名原文，写错会验签失败。
   * ⚠️ 每钱包只能成功一次，重复调用会被合约以 SanguoAlreadyMigrated 拒绝。
   */
  async function doMigrateFromOld() {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    const log = $('sgMigrateLog');
    showBusy(t('migrate_doing'));
    try {
      // 🟢 发交易前再核一次老合约卡数（预览到点击之间玩家可能又分解/抽了卡）
      const n = await fetchOldCardCount();
      oldMigrateCardCount = n;

      // 🟢 超限保护：超过 30 张直接拦下，不发出注定 out of gas 的交易
      //    （Cosmos 里 out of gas 照样扣手续费，拦下能帮玩家省这笔钱）
      if (n != null && n > MIGRATE_MAX_CARDS) {
        const tip = tf('migrate_over_limit', { n, max: MIGRATE_MAX_CARDS, over: n - MIGRATE_MAX_CARDS });
        if (log) log.innerHTML = `<div class="hint err" style="margin-top:6px">⚠️ ${esc(tip)}</div>`;
        const bb = $('sgMigrateBtn'); if (bb) { bb.disabled = true; bb.textContent = t('migrate_blocked'); }
        showToast(tip, 'error');
        return;
      }

      // 🟢 gas 随卡数线性增长（实测 ≈ 36 万固定 + 3 万/张），默认 600k 上限会被撑爆。
      //    这里按实际卡数自适应（30 张 → 220 万；查不到卡数按 30 张满额 220 万准备）。
      //    未用完的 gas 会原路退还，抬高上限不会让玩家多掏钱。
      const gasLimit = migrationGasLimit(n);
      const { tx } = await sanguoExec(
        'SanguoMigrateFromOld',
        { old_contract: OLD_SANGUO_CONTRACT },
        { action: 'migrate', spend: 0, gasLimit },
      );
      const a = parseTxEvents(tx, ['cards_minted', 'cards_skipped', 'fragments_migrated']);
      const minted = (a.cards_minted && a.cards_minted[0]) || '0';
      const skipped = (a.cards_skipped && a.cards_skipped[0]) || '0';
      const frags = (a.fragments_migrated && a.fragments_migrated[0]) || '0';
      migrationDone = true;
      if (log) log.innerHTML = `<div class="hint ok" style="margin-top:6px">${tf('migrate_ok_detail', { msg: t('migrate_ok'), minted, frags, skipped: Number(skipped) ? tf('migrate_ok_skip', { n: skipped }) : '' })}</div>`;
      const b = $('sgMigrateBtn'); if (b) b.disabled = true;
      await loadSanguoCards();
      await refreshBalances();
      showToast(t('migrate_ok'), 'success');
      renderSanguoTab();
    } catch (e) {
      const msg = String(e.message || e);
      if (/already migrated/i.test(msg)) {
        migrationDone = true;
        if (log) log.innerHTML = `<div class="hint" style="margin-top:6px">ℹ️ ${t('migrate_done')}</div>`;
        const b = $('sgMigrateBtn'); if (b) b.disabled = true;
        showToast(t('migrate_done'), 'error');
      } else {
        if (log) log.innerHTML = `<div class="hint err" style="margin-top:6px">❌ ${esc(msg)}</div>`;
        showToast(t('fail_prefix') + msg, 'error');
      }
    } finally { hideBusy(); }
  }

  async function doClaimReward(battleId) {
    try {
      await requireSanguo();
    } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      const res = await sanguoExec('SanguoClaimReward', { battle_id: battleId }, { action: 'claim_reward', spend: 0 });
      sgClaimToast(res.tx, 'ok_short');
      renderSanguoTab();
    } catch (e) {
      showToast(t('fail_prefix') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  async function doClaimAll(ids) {
    try {
      await requireSanguo();
    } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      let inSum = 0n, burnSum = 0n;
      for (const id of ids) {
        const r = await sanguoExec('SanguoClaimReward', { battle_id: id }, { action: 'claim_reward', spend: 0 });
        const m = sgTkccEvents(r.tx);
        inSum += m.inbound; burnSum += m.burn;
      }
      if (inSum > 0n) {
        showToast(tf((burnSum > 0n) ? 'claim_in_burn' : 'claim_in', {
          amt: fromRawUnits(String(inSum), 6),
          burned: fromRawUnits(String(burnSum), 6),
        }), 'success');
      } else { showToast(t('ok_short'), 'success'); }
      renderSanguoTab();
    } catch (e) {
      showToast(t('fail_prefix') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // ============================================================
  // 卡图懒加载 + 加载骨架屏（20261013-2，纯渲染层，无业务逻辑）
  //   懒加载：IntersectionObserver + rootMargin 200px；不支持时直接加载。
  //   骨架屏：仅「我的卡 / 商店」等异步加载前占位，落地 index.html 的 .skeleton。
  // ============================================================
  let _sgImgObserver = null;
  function sgObserveLazyImages(root) {
    const scope = root || document;
    const imgs = scope.querySelectorAll('img[data-src]');
    if (!imgs.length) return;
    if (!('IntersectionObserver' in window)) {
      imgs.forEach((im) => { if (im.dataset.src) { im.src = im.dataset.src; im.removeAttribute('data-src'); } });
      return;
    }
    if (!_sgImgObserver) {
      _sgImgObserver = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const im = en.target;
          if (im.dataset.src) { im.src = im.dataset.src; im.removeAttribute('data-src'); }
          _sgImgObserver.unobserve(im);
        });
      }, { rootMargin: '200px 0px', threshold: 0.01 });
    }
    imgs.forEach((im) => _sgImgObserver.observe(im));
  }
  // 卡片骨架（卡列表用）
  function sgSkeletonCards(n) {
    let h = '';
    for (let i = 0; i < n; i++) {
      h += `<div class="sg-card skeleton-card">`
        + `<div class="sg-card-img skeleton"></div>`
        + `<div class="sg-card-foot"><div class="nm skeleton">　</div><div class="rr skeleton">　</div></div>`
        + `</div>`;
    }
    return h;
  }
  // 商品骨架（商店用）
  function sgSkeletonProducts(n) {
    let h = '';
    for (let i = 0; i < n; i++) h += `<div class="shop-card skeleton"></div>`;
    return `<div class="shop-grid">${h}</div>`;
  }

  function cardHtml(c) {
    const img = getCardImage(c.name);
    const col = rarityColor(c.rarity);
    const cls = rarityClass(c.rarity);
    const cid = esc(c.card_id);
    const lvTxt = (c.star > 1 || c.level > 0) ? `<div class="sg-card-lv">★${c.star || 1}${c.level ? ' Lv' + c.level : ''}</div>` : '';
    // 🟢 阵营行（2026-09-29）：链上卡不带阵营，按名字查模板补齐（图鉴与我的卡一致）
    const idt = sgCardIdentity(c);
    const ffHtml = idt ? `<div class="ff" style="color:${sgFactionColor(idt)}">${esc(idt)}</div>` : '';
    // 🟢 卡面文字层级（20261013-2）：姓名 + 称号 + 阵营/官职
    const tplc = sgTplByName(c.name) || {};
    const ttHtml = tplc.title ? `<div class="tt">${esc(tplc.title)}</div>` : '';
    // 🟢 批量分解模式：点击只切换勾选，不进详情
    if (sgBatchMode) {
      const sel = sgBatchSel.has(c.card_id);
      return `<div class="sg-card ${cls}${sel ? ' sg-sel' : ''}" data-bcid="${c.card_id}" onclick="sgToggleBatch('${cid}')">
        ${lvTxt}
        ${sel ? '<div class="sg-pick-ord">✓</div>' : ''}
        <div class="sg-card-img"><img data-src="${img}" loading="lazy" decoding="async" onerror="this.style.display='none'"></div>
        <div class="sg-card-foot"><div class="nm">${esc(c.name)}</div>${ttHtml}${ffHtml}<div class="rr">${rarityLabel(c.rarity)}</div></div>
      </div>`;
    }
    // 🟢「我的卡牌」只展示卡牌参数，不放养成按钮（升级/升星/分解统一到「养成」页）。
    return `<div class="sg-card ${cls}${sgJustDrew ? ' new-card' : ''}" onclick="openCardDetailFromId('${cid}')">
      ${lvTxt}
      <div class="sg-card-img"><img data-src="${img}" loading="lazy" decoding="async" onerror="this.style.display='none'"></div>
      <div class="sg-card-foot">
        <div class="nm">${esc(c.name)}</div>
        ${ttHtml}
        ${ffHtml}
        <div class="rr">${rarityLabel(c.rarity)} · ${t('power_label')} ${power(c)}</div>
      </div>
    </div>`;
  }
  // 批量分解：切换勾选并刷新计数
  function sgToggleBatch(cid) {
    if (sgBatchSel.has(cid)) sgBatchSel.delete(cid); else sgBatchSel.add(cid);
    const cnt = $('sgBatchCount');
    if (cnt) cnt.textContent = String(sgBatchSel.size);
    const grid = $('sgCardGrid');
    if (grid) {
      const el = grid.querySelector(`.sg-card[data-bcid="${cid}"]`);
      if (el) el.classList.toggle('sg-sel', sgBatchSel.has(cid));
    }
  }
  window.sgToggleBatch = sgToggleBatch;
  // 静默分解（批量用：不弹确认、不弹单卡 toast，失败向上抛）
  async function doDecomposeSilent(cardId) {
    await requireSanguo();
    const card = userCards.find((c) => c.card_id === cardId);
    if (!card) return;
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoDecompose', { card_id: cardId }, { action: 'decompose', spend: 0 });
    } finally {
      hideBusy();
      try { await loadSanguoCards(); } catch (_) {}
    }
  }
  async function sgBatchDecompose() {
    const ids = Array.from(sgBatchSel);
    if (!ids.length) { showToast(t('batch_none'), 'error'); return; }
    if (!confirm(tf('batch_decompose_confirm', { n: ids.length }))) return;
    showBusy(t('doing'));
    let okN = 0;
    try {
      for (const id of ids) { await doDecomposeSilent(id); okN++; }
      showToast(tf('batch_decompose_ok', { n: okN }), 'success');
    } catch (e) {
      showToast(t('fail_prefix') + (e.message || e), 'error');
    } finally {
      hideBusy();
      sgBatchMode = false; sgBatchSel.clear();
      renderSanguoTab();
    }
  }
  window.sgBatchDecompose = sgBatchDecompose;

  // ============================================================
  // 卡牌选择面板（养成-出战顺序 / PVP / 混战 共用）
  // ============================================================
  function sanguoRenderPicker(containerId, max) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    if (!userCards.length) {
      grid.innerHTML = `<div class="hint">${t('empty_cards')}</div>`;
      return;
    }
    grid.innerHTML = userCards.map((c) => {
      const idx = sanguoPicked.indexOf(c.card_id);
      const sel = idx >= 0;
      const col = rarityColor(c.rarity);
      const badge = sel ? `<div class="sg-pick-ord">${idx + 1}</div>` : '';
      return `<div class="sg-pick" data-cid="${c.card_id}" style="position:relative;border:2px solid ${sel ? col : '#2a3756'};border-radius:8px;padding:4px;cursor:pointer;background:${sel ? 'rgba(255,255,255,.06)' : '#0d1322'};text-align:center">
        ${badge}
        <div style="font-size:11px;font-weight:700;color:#fff">${esc(c.name)}</div>
        <div style="font-size:9px;color:${col}">${rarityLabel(c.rarity)} · ${power(c)}</div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.sg-pick').forEach((el) => {
      el.onclick = () => {
        const cid = el.dataset.cid;
        const idx = sanguoPicked.indexOf(cid);
        if (idx >= 0) sanguoPicked.splice(idx, 1);
        else {
          if (sanguoPicked.length >= max) { showToast(tf('pick_limit',{n:max}), 'error'); return; }
          sanguoPicked.push(cid);
        }
        sanguoRenderPicker(containerId, max);
        // 🟢 同步刷新依赖「选满 9 张」状态的按钮（关卡挑战 / 天梯开始）
        const full = sanguoPicked.length >= 9;
        document.querySelectorAll('button[data-stage]').forEach((b) => { b.disabled = !full; });
        const rs = $('sgRankStart'); if (rs) rs.disabled = !full;
      };
    });
  }

  // ============================================================
  // AI 对战
  // ============================================================
  async function renderAiBattle(body) {
    await loadParams();
    // 🟢 9v9 合并 API：合约 battle_ai 要求 9 张真卡（load_battle_team_checked ==9），
    //    前端门槛与合约对齐：不足 9 张不允许发起（避免必败交易弹窗）。
    if (state.wallet) await loadSanguoCards();
    const cardCount = userCards.length;
    const enoughCards = cardCount >= 9;
    body.innerHTML = `
      <div class="card" id="sgAiPendingCard" style="display:none">
        <div class="card-title">🎁 ${t('pending_reward')}（<span id="sgAiPendingTotal">0</span> 碎片）</div>
        <div class="hint" id="sgAiPendingHint"></div>
        <button class="btn btn-gold" id="sgAiClaimAll" style="margin-top:8px;width:100%">${t('claim_btn')}</button>
      </div>
      <div class="card">
        <div class="card-title">⚔️ ${t('ai_title')}</div>
        <div class="desc">${t('ai_desc')}</div>
      </div>
      <div class="card">
        <div class="kv"><span class="k">${t('ai_today')}</span><span class="v" id="sgAiToday">—</span></div>
        <div class="kv"><span class="k">${t('ai_limit')}</span><span class="v" id="sgAiLimit">—</span></div>
        <div class="kv"><span class="k">${t('win_rate')}</span><span class="v" id="sgAiRate">—</span></div>
        <div class="kv"><span class="k">${t('ai_my_cards')}</span><span class="v" id="sgAiCards">${cardCount} / 9</span></div>
      </div>
      <div class="card">
        <div class="card-title">${t('ai_pick_title')}</div>
        <div class="desc">${t('ai_pick_desc')}</div>
        <div id="sgAiPick" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;margin-top:8px"></div>
      </div>
      <div class="card">
        <div class="card-title">${t('ai_diff')}</div>
        <select id="sgAiDiff" class="input">
          ${[1,2,3,4,5].map((d) => {
            const idx = d - 1;
            // 🟢 合并 API：ai_frag_reward 现为 Fragments 对象（msg.rs:776），展示为四档碎片总数
            const fr = (paramsCache && paramsCache.ai_frag_reward) ? paramsCache.ai_frag_reward[idx] : null;
            const frag = fr && typeof fr === 'object'
              ? (Number(fr.common || 0) + Number(fr.rare || 0) + Number(fr.epic || 0) + Number(fr.legend || 0))
              : (fr || '—');
            return `<option value="${d}">${t('ai_diff')} ${d} · 🧩 ${t('win_frag')} ${frag}</option>`;
          }).join('')}
        </select>
        <button class="btn btn-primary" id="sgAiGo" style="margin-top:10px;width:100%" ${enoughCards ? '' : 'disabled'}>${enoughCards ? t('ai_title') : t('ai_need_three_btn')}</button>
        ${enoughCards ? '' : `<div class="hint err" style="margin-top:8px">${t('ai_need_three_hint')}</div>`}
      </div>
      <div id="sgAiLog"></div>`;
    if (state.wallet) {
      try {
        const s = await queryContract({ sanguo_ai_stats: { address: state.wallet.address } });
      if (s) {
        sgAiStats = s;
        $('sgAiToday').textContent = (s.today_count != null ? s.today_count : '0') + ' / ' + (s.daily_limit != null ? s.daily_limit : '0');
        $('sgAiLimit').textContent = s.daily_limit != null ? s.daily_limit : '—';
        $('sgAiRate').textContent = s.win_rate != null ? s.win_rate : '—';
        sgSyncWallet();
      }
      } catch (e) { /* 忽略 */ }
    }
    // 🟢 9v9：进入页面时用链上出战顺序预填选卡面板（最多 9 张）
    if (state.wallet && userCards.length) {
      try {
        const bo = await queryContract({ sanguo_battle_order: { player: state.wallet.address } });
        if (bo && bo.order && bo.order.length) {
          const ids = bo.order.filter((id) => userCards.some((c) => c.card_id === id)).slice(0, 9);
          if (ids.length) sanguoPicked = ids;
        }
      } catch (e) {}
      sanguoRenderPicker('sgAiPick', 9);
    }
    $('sgAiGo').onclick = () => doAiBattle();

    // 🟢 待领取横幅：赢局奖励先进合约 pending（sanguo_pending），必须点「领取」才真正转账。
    //    原领取入口只在「我的卡」页，玩家在 AI 对战页看不到 → 这里补一个一键领取入口。
    if (state.wallet) {
      try {
        const pend = await queryContract({ sanguo_pending: { address: state.wallet.address } });
        const ids = (pend && pend.battle_ids) || [];
        if (ids.length) {
          $('sgAiPendingCard').style.display = '';
          $('sgAiPendingTotal').textContent = fromRawUnits((pend && pend.total_rewards) || '0');
          $('sgAiPendingHint').textContent = tf('ai_pending_hint', { n: ids.length });
          $('sgAiClaimAll').onclick = () => doClaimAll(ids);
        }
      } catch (e) { /* 查询失败不阻断对战页 */ }
    }
  }

  // 🟢 安全审计 O-1：编队 Σcost 预检（合约 load_battle_team_checked：Σcost ≤ params.team_cost_cap）。
  //    模板 cost 或 cap 数据缺失时不阻断（交由合约兜底拒绝）；超限就地报错，避免必败交易白烧 gas。
  function sgCardCost(c) {
    const tpl = sgTplByName(c.name) || {};
    return (tpl.cost != null) ? Number(tpl.cost || 0) : -1; // -1 = 未知
  }
  function sgTeamCostOk(ids) {
    let total = 0, unknown = false;
    (ids || []).forEach((id) => {
      const c = userCards.find((x) => x.card_id === id);
      if (!c) { unknown = true; return; }
      const cc = sgCardCost(c);
      if (cc < 0) unknown = true; else total += cc;
    });
    const cap = paramsCache ? Number(paramsCache.team_cost_cap || 0) : 0;
    if (unknown || !(cap > 0)) return true;
    if (total <= cap) return true;
    showToast(tf('team_cost_over', { total, cap }), 'error');
    return false;
  }

  async function doAiBattle() {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    try { await loadParams(); } catch (e) { showToast(t('params_err'), 'error'); return; }
    // 🟢 合并 API：合约 battle_ai 要求 9 张真卡（9v9 真卡对战）；不足 9 张无法组队
    if (!userCards || userCards.length < 9) {
      try { await loadSanguoCards(); } catch (e) {}
      if (!userCards || userCards.length < 9) {
        const msg = t('need_nine');
        const logEl = $('sgAiLog');
        if (logEl) logEl.innerHTML = `<div class="hint err">❌ ${esc(msg)}</div>`;
        showToast(msg, 'error');
        return;
      }
    }
    // 🟢 合并 API：玩家必须显式提交 9 张真卡（合约 load_battle_team_checked），不再读链上 battle order
    let team = sanguoPicked.slice(0, 9);
    if (team.length < 9) {
      try {
        const bo = await queryContract({ sanguo_battle_order: { player: state.wallet.address } });
        if (bo && bo.order) team = bo.order.filter((id) => userCards.some((c) => c.card_id === id)).slice(0, 9);
      } catch (e) { /* 链上无出战顺序则兜底取高战力 */ }
    }
    if (team.length < 9) {
      const cap = paramsCache ? Number(paramsCache.team_cost_cap || 0) : 0;
      if (cap > 0 && userCards.every((c) => sgCardCost(c) >= 0)) {
        // 🟢 O-1：按性价比（战力/cost）贪心组队，Σcost ≤ team_cost_cap
        const byEff = [...userCards].filter((c) => sgCardCost(c) > 0)
          .sort((a, b) => (power(b) / sgCardCost(b)) - (power(a) / sgCardCost(a)));
        const picked = [];
        let total = 0;
        for (const c of byEff) {
          if (picked.length >= 9) break;
          const cc = sgCardCost(c);
          if (total + cc <= cap) { picked.push(c.card_id); total += cc; }
        }
        // cost=0 的卡不计成本，任意补位
        for (const c of [...userCards].sort((a, b) => power(b) - power(a))) {
          if (picked.length >= 9) break;
          if (!picked.includes(c.card_id) && sgCardCost(c) === 0) picked.push(c.card_id);
        }
        if (picked.length >= 9) team = picked;
      }
      if (team.length < 9) {
        team = [...userCards].sort((a, b) => power(b) - power(a)).slice(0, 9).map((c) => c.card_id);
      }
    }
    if (team.length < 9) { showToast(t('need_nine'), 'error'); return; }
    // 🟢 O-1：所有组队路径统一做 Σcost 预检（数据可用时），超限就地拦截
    if (!sgTeamCostOk(team)) return;
    const diff = Number(($('sgAiDiff') || {}).value || 1);
    showBusy(t('doing'));
    try {
      const res = await sanguoExec('SanguoBattleAi', { mode: 'casual', level: diff, card_ids: team }, { action: 'battle_ai', spend: 0, extra: 'casual:battle:' + diff });
      showToast(t('free_entry_ok'), 'success');
      // 🟢 前端新增：对战竞技场（双方出牌 + 胜负 + 奖励）
      try { await showAiBattleFromTx(res.tx, diff); } catch (_) { /* 展示失败不影响主流程 */ }
      renderSanguoTab();
    } catch (e) {
      $('sgAiLog').innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
      showToast(t('fail_prefix') + (e.message || e), 'error');
    } finally { hideBusy(); }
  }

  // 🟢 AI/PVP/关卡共用：确保链上出战顺序 = 当前选中的 sanguoPicked（9 张，3 组 × 3 张），
  //    与链上不一致才发交易，避免无谓的 set_battle_order。
  async function ensureBattleOrder() {
    const want = sanguoPicked.slice(0, 9);
    if (want.length < 9) return;
    let cur = [];
    try {
      const bo = await queryContract({ sanguo_battle_order: { player: state.wallet.address } });
      cur = (bo && bo.order) || [];
    } catch (e) {}
    const same = cur.length === want.length && cur.every((id, i) => id === want[i]);
    if (!same) {
      await sanguoExec('SanguoSetBattleOrder', { order: want }, { action: 'set_battle_order', spend: 0 });
    }
  }

  // ============================================================
  // 养成（碎片 / 出战顺序 / 升星 / 分解 / 升级 / 合成）
  // ============================================================
  async function renderCultivate(body) {
    await loadParams();
    if (state.wallet) await loadSanguoCards();
    sanguoPicked = [];
    body.innerHTML = `
      <div class="card">
        <div class="card-title">🌱 ${t('cult_title')}</div>
        <div class="desc">${t('cult_desc')}</div>
      </div>
      <div class="card">
        <div class="card-title">${t('frag_title')}</div>
        <div class="kv"><span class="k">${t('rarity_common')}</span><span class="v" id="sgFragC">0</span></div>
        <div class="kv"><span class="k">${t('rarity_rare')}</span><span class="v" id="sgFragR">0</span></div>
        <div class="kv"><span class="k">${t('rarity_epic')}</span><span class="v" id="sgFragE">0</span></div>
        <div class="kv"><span class="k">${t('rarity_legend')}</span><span class="v" id="sgFragL">0</span></div>
      </div>
      <div class="card">
        <div class="card-title">${t('order_title')} <span style="font-size:12px;color:#9fb3d1">(${t('order_max')})</span></div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0" id="sgOrderPick"></div>
        <button class="btn btn-primary" id="sgSetOrder">${t('set_order_btn')}</button>
      </div>
      <div class="card" id="sgCraftCard">
        <div class="card-title">✨ ${t('craft_btn')}</div>
        <div class="desc">${t('craft_desc')}</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 10px;font-size:12px">
          <span style="color:#b9a58f">🟤 ${t('rarity_common')} <b id="craftFragCommon">0</b></span>
          <span style="color:#4a9eff">🔵 ${t('rarity_rare')} <b id="craftFragRare">0</b></span>
          <span style="color:#b14aff">🟣 ${t('rarity_epic')} <b id="craftFragEpic">0</b></span>
          <span style="color:#ffd700">🟡 ${t('rarity_legend')} <b id="craftFragLegend">0</b></span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-secondary" data-craft="common">${tf('craft_common', { cost: sgCraftCost('common') })}</button>
          <button class="btn btn-primary" data-craft="rare">${tf('craft_rare', { cost: sgCraftCost('rare') })}</button>
          <button class="btn btn-gold" data-craft="epic">${tf('craft_epic', { cost: sgCraftCost('epic') })}</button>
          <button class="btn btn-gold" data-craft="legend" style="background:linear-gradient(135deg,#ffd700,#ff8c00);color:#3a2400">${tf('craft_legend', { cost: sgCraftCost('legend') })}</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">🃏 ${t('my_cards')}</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px" id="sgCultGrid"></div>
      </div>`;
    if (state.wallet) {
      try {
        const f = await queryContract({ sanguo_fragments: { address: state.wallet.address } });
        if (f) {
          $('sgFragC').textContent = f.common; $('sgFragR').textContent = f.rare;
          $('sgFragE').textContent = f.epic; $('sgFragL').textContent = f.legend;
          const sum = (Number(f.common) || 0) + (Number(f.rare) || 0) + (Number(f.epic) || 0) + (Number(f.legend) || 0);
          sgFragCache = sum; sgSyncWallet();
          // 合成区（老版样式）里的四档碎片余额同步刷新
          sgFrags = {
            common: Number(f.common) || 0, rare: Number(f.rare) || 0,
            epic: Number(f.epic) || 0, legend: Number(f.legend) || 0,
          };
          const setF = (id, v) => { const el = $(id); if (el) el.textContent = v; };
          setF('craftFragCommon', sgFrags.common); setF('craftFragRare', sgFrags.rare);
          setF('craftFragEpic', sgFrags.epic); setF('craftFragLegend', sgFrags.legend);
        }
      } catch (e) {}
    }
    // 🟢 多钱包 + 出战顺序：预填链上已存的出战顺序（按当前钱包），顺序即出牌顺序：第 1 个先出
    if (state.wallet) {
      try {
        const bo = await queryContract({ sanguo_battle_order: { player: state.wallet.address } });
        if (bo && bo.order && bo.order.length) {
          const ids = bo.order.filter((id) => userCards.some((c) => c.card_id === id));
          if (ids.length) sanguoPicked = ids;
        }
      } catch (e) {}
    }
    sanguoRenderPicker('sgOrderPick', 9);
    $('sgSetOrder').onclick = () => doSetBattleOrder();
    // 🟢 老版样式：四档稀有度各自一个合成按钮，直接点对应稀有度即可（不再下拉选择）
    document.querySelectorAll('#sgCraftCard button[data-craft]').forEach((b) => {
      b.onclick = () => doCraft(b.dataset.craft);
    });
    const grid = $('sgCultGrid');
    if (!userCards.length) {
      grid.innerHTML = `<div class="hub-empty" style="grid-column:1/-1"><span class="ic">🌱</span>${t('empty_cards')}</div>`;
    } else {
      grid.innerHTML = userCards.map((c) => {
        const col = rarityColor(c.rarity);
        const img = getCardImage(c.name);
        const tplc = sgTplByName(c.name) || {};
        const ttHtml = tplc.title ? `<div class="tt">${esc(tplc.title)}</div>` : '';
        // 🟢 养成页战斗属性（2026-10-14）：兵种 / 技能（3★ 解锁态）/ 连携
        const stC = c.star || 1;
        const skC = tplc.skill_id ? sgFindSkill(tplc.skill_id) : null;
        const skillLine = skC
          ? `<div style="font-size:10px;color:${stC >= 3 ? '#ffd700' : '#9fb3d1'}">✦ ${stC >= 3 ? sgSkillDesc(tplc.skill_id) : tf('skill_locked', { name: skC[0] })}</div>`
          : '';
        const troopLine = tplc.troop ? `<div style="font-size:10px;color:#9fb3d1">⚔️ ${t('troop_' + tplc.troop)}</div>` : '';
        const bondLine = (tplc.bonds && tplc.bonds.length) ? `<div style="font-size:9px;color:#9fb3d1">🔗 ${esc(sgBondNames(tplc.bonds))}</div>` : '';
        // 🟢 养成页：卡牌图（小尺寸）+ 下方「升星 / 升星·F / 升级 / 分解」按钮。
        //    渲染结构变化，按钮动作仍走原 doStarUp / doUpgrade / doDecompose，逻辑零改动。
        return `<div class="sg-cult-card" style="border-color:${col}">
          <div class="sg-cult-img"><img data-src="${img}" loading="lazy" decoding="async" onerror="this.style.display='none'"></div>
          <div class="sg-cult-info">
            <div class="nm">${esc(c.name)}</div>
            ${ttHtml}
            <div class="rr" style="color:${col}">${rarityLabel(c.rarity)} ★${c.star||1} Lv${c.level||0} · ${power(c)}</div>
            ${troopLine}${skillLine}${bondLine}
          </div>
          <div class="sg-cult-acts">
            <!-- 🟢 合规化：TKCC 升星路径已移除（合约 upgrade_fees 已 deprecated、恒按碎片扣），
                 仅保留碎片升星，杜绝 TKCC 触点 -->
            <button class="btn btn-sm btn-ghost" data-act="star_frag" data-cid="${c.card_id}">${t('starup_btn')}·F</button>
            <button class="btn btn-sm btn-ghost" data-act="upgrade" data-cid="${c.card_id}">${t('upgrade_btn')}</button>
            <button class="btn btn-sm btn-ghost" data-act="decompose" data-cid="${c.card_id}">${t('decompose_btn')}</button>
          </div>
        </div>`;
      }).join('');
      sgObserveLazyImages(grid);   // 养成卡图懒加载
      grid.querySelectorAll('button[data-act]').forEach((b) => {
        b.onclick = () => {
          const act = b.dataset.act, cid = b.dataset.cid;
          if (act === 'star_frag') doStarUp(cid, true);
          else if (act === 'upgrade') doUpgrade(cid);
          else if (act === 'decompose') doDecompose(cid);
        };
      });
    }
  }

  async function doSetBattleOrder() {
    if (!sanguoPicked.length) { showToast(t('select_card_first'), 'error'); return; }
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoSetBattleOrder', { order: sanguoPicked.slice() }, { action: 'set_battle_order', spend: 0 });
      const names = sanguoPicked.map((id) => { const c = userCards.find((x) => x.card_id === id); return c ? c.name : id; });
      showToast(`${t('ok_short')} · ${tf('order_saved', { names: names.join(' → ') })}`, 'success');
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }
  // 🟢 养成预检（2026-09-20）：与老版 paxi-card-game 对齐。
  //    此前升星/升级/分解无任何前端预检：5★ 满星卡照样发交易、余额不够照样发交易，
  //    全部被合约拒绝 → 白烧 gas（链上实测：两笔 sanguo_star_up 报
  //    "Card already at maximum star"，每笔白扣手续费）。
  //    数值必须与合约一致：
  //    · src/sanguo/state.rs::upgrade_fees = [50000,150000,400000,1000000]（TKCC，50% 销毁）
  //    · 升星碎片路径 = STAR_UP_FRAGMENT_COST[稀有度] → [50,100,200,500]（按稀有度，与星级无关，与升级碎片同表）
  //    · 升级每级碎片 = 同表 50/100/200/500（按稀有度）
  //    · 分解返还 = 5/10/20/50（按稀有度）
  // 🟢 3A：养成常量兜底（链上读不到时用），正常路径从 paramsCache 派生
  const SG_CONST_FALLBACK = {
    upgrade_fees_raw: [50_000_000_000n, 150_000_000_000n, 400_000_000_000n, 1_000_000_000_000n],
    craft_cost: [30, 60, 150, 400],
    decompose_frag_back: [5, 10, 20, 50],
    star_up_frag_cost: [50, 100, 200, 500],
  };
  const _RI = { common: 0, rare: 1, epic: 2, legend: 3 };

  /** 升星 TKCC 费用（raw BigInt 数组），优先链上，失败回退 */
  function sgUpgradeFeesRaw() {
    const p = paramsCache;
    if (p && Array.isArray(p.upgrade_fees) && p.upgrade_fees.length === 4) {
      try { return p.upgrade_fees.map((s) => BigInt(s)); } catch (e) {}
    }
    return SG_CONST_FALLBACK.upgrade_fees_raw;
  }
  /** 合成消耗碎片数（按稀有度字符串） */
  function sgCraftCost(rarity) {
    const ri = _RI[rarity]; if (ri == null) return 0;
    const p = paramsCache;
    if (p && Array.isArray(p.craft_cost) && p.craft_cost[ri] != null) return Number(p.craft_cost[ri]);
    return SG_CONST_FALLBACK.craft_cost[ri] || 0;
  }
  /** 分解返还碎片数 */
  function sgDecomposeBack(rarity) {
    const ri = _RI[rarity]; if (ri == null) return 0;
    const p = paramsCache;
    if (p && Array.isArray(p.fragment_from_duplicate) && p.fragment_from_duplicate[ri] != null) return Number(p.fragment_from_duplicate[ri]);
    return SG_CONST_FALLBACK.decompose_frag_back[ri] || 0;
  }
  /** 升星/升级 消耗碎片数 */
  function sgStarUpFragCost(rarity) {
    const ri = _RI[rarity]; if (ri == null) return 0;
    const p = paramsCache;
    if (p && Array.isArray(p.star_up_fragment_cost) && p.star_up_fragment_cost[ri] != null) return Number(p.star_up_fragment_cost[ri]);
    return SG_CONST_FALLBACK.star_up_frag_cost[ri] || 0;
  }
  // 🟢 7A：当前支付币种展示标签
  function currentPayLabel() {
    const token = (paramsCache && paramsCache.pay_token) || '';
    return token ? `PRC-20 (${token.slice(0, 10)}…)` : 'PAXI（原生）';
  }
  // 🟢 7A：为当前币种构造 funds（PAXI 走 funds，PRC-20 走内部余额）
  function paymentFunds(priceStr) {
    const token = (paramsCache && paramsCache.pay_token) || '';
    return token ? [] : [{ denom: 'upaxi', amount: String(priceStr) }];
  }

  // 查合约内 TKCC 余额（raw）。查询失败返回 null（调用方决定是否放行）。
  async function sgInContractTkcc() {
    try {
      const b = await queryContract({ balance: { address: state.wallet.address, token: CONTRACTS.tkcc } });
      return BigInt(b.amount || '0');
    } catch (e) { return null; }
  }
  // 查某稀有度碎片（以链上为准，顺带刷新缓存；失败退回缓存值）
  async function sgFragOf(rarity) {
    try {
      const f = await queryContract({ sanguo_fragments: { address: state.wallet.address } });
      if (f && f[rarity] != null) { sgFrags[rarity] = Number(f[rarity]) || 0; return sgFrags[rarity]; }
    } catch (e) {}
    return sgFrags[rarity] || 0;
  }

  async function doStarUp(cardId, useFragments) {
    // 🟢 合规化：合约 star_up 恒按碎片扣费（upgrade_fees 已 deprecated），TKCC 路径已删，
    //    此处强制走碎片分支（即便误传 useFragments=false 也不会触发任何 TKCC 预检）
    useFragments = true;
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    const card = userCards.find((c) => c.card_id === cardId);
    if (!card) { showToast(t('err_card_notfound'), 'error'); return; }
    const star = card.star || 1;
    if (star >= 5) { showToast(t('err_max_star'), 'error'); return; }
    const fragNeed = sgStarUpFragCost(card.rarity); // 合约按稀有度固定 50/100/200/500，与星级无关
    const have = await sgFragOf(card.rarity);
    if (have < fragNeed) {
      showToast(tf('err_frag_star', { need: fragNeed, rarity: rarityLabel(card.rarity), have }), 'error');
      return;
    }
    if (!confirm(tf('confirm_star_frag', { from: star, to: star + 1, need: fragNeed, rarity: rarityLabel(card.rarity), have }))) return;
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoStarUp', { card_id: cardId, use_fragments: useFragments }, { action: 'star_up', spend: 0 });
      showToast(t('ok_short'), 'success');
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally {
      hideBusy();
      // 🟢 无论成功/失败都从链上重拉一次卡牌与碎片再渲染：
      //    避免「链上已成功、但本地缓存没刷新」让玩家以为没升星/没升级；
      //    即便本次超时误报失败，只要链上真成功了，这里也会显示真实状态。
      try { await loadSanguoCards(); } catch (_) {}
      renderSanguoTab();
    }
  }
  async function doUpgrade(cardId) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    const card = userCards.find((c) => c.card_id === cardId);
    if (!card) { showToast(t('err_card_notfound'), 'error'); return; }
    const lv = card.level || 0;
    if (lv >= 10) { showToast(t('err_max_level'), 'error'); return; }
    const perLv = sgStarUpFragCost(card.rarity);
    const have = await sgFragOf(card.rarity);
    if (have < perLv) {
      showToast(tf('err_frag_level', { from: lv, to: lv + 1, need: perLv, rarity: rarityLabel(card.rarity), have }), 'error');
      return;
    }
    if (!confirm(tf('confirm_level_up', { from: lv, to: lv + 1, need: perLv, rarity: rarityLabel(card.rarity), have }))) return;
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoUpgrade', { card_id: cardId }, { action: 'upgrade', spend: 0 });
      showToast(t('ok_short'), 'success');
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally {
      hideBusy();
      // 🟢 无论成功/失败都从链上重拉一次卡牌与碎片再渲染：
      //    避免「链上已成功、但本地缓存没刷新」让玩家以为没升星/没升级；
      //    即便本次超时误报失败，只要链上真成功了，这里也会显示真实状态。
      try { await loadSanguoCards(); } catch (_) {}
      renderSanguoTab();
    }
  }
  async function doDecompose(cardId) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    const card = userCards.find((c) => c.card_id === cardId);
    if (!card) { showToast(t('err_card_notfound'), 'error'); return; }
    const back = sgDecomposeBack(card.rarity);
    // 分解是销毁性操作：老版同款确认框，写清「不退还已投入」避免养成后白烧
    if (!confirm(tf('confirm_decompose', { name: card.name, star: card.star || 1, lv: card.level || 0, back, rarity: rarityLabel(card.rarity) }))) return;
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoDecompose', { card_id: cardId }, { action: 'decompose', spend: 0 });
      showToast(t('ok_short'), 'success');
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally {
      hideBusy();
      // 🟢 无论成功/失败都从链上重拉一次卡牌与碎片再渲染：
      //    避免「链上已成功、但本地缓存没刷新」让玩家以为没升星/没升级；
      //    即便本次超时误报失败，只要链上真成功了，这里也会显示真实状态。
      try { await loadSanguoCards(); } catch (_) {}
      renderSanguoTab();
    }
  }
  async function doCraft(rarity) {
    rarity = rarity || 'common';
    // 前端先校验碎片（与合约 CRAFT_COST 一致，链上派生），不够就直接拦下，不浪费一次签名
    const cost = sgCraftCost(rarity);
    const have = (sgFrags && sgFrags[rarity]) || 0;
    if (have < cost) {
      showToast(tf('craft_insufficient', { need: cost, have }), 'error');
      return;
    }
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoCraft', { rarity }, { action: 'craft', spend: 0 });
      showToast(t('ok_short'), 'success');
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally {
      hideBusy();
      // 🟢 无论成功/失败都从链上重拉一次卡牌与碎片再渲染：
      //    避免「链上已成功、但本地缓存没刷新」让玩家以为没升星/没升级；
      //    即便本次超时误报失败，只要链上真成功了，这里也会显示真实状态。
      try { await loadSanguoCards(); } catch (_) {}
      renderSanguoTab();
    }
  }

  // ============================================================
  // 🟢 合规化（T24 投票全禁）：提案系统已整体下线。
  //    合约源码已删除 SanguoProposeCard/VoteCard/ExecuteProposal/CancelProposal
  //    执行入口与 SanguoProposals 查询；前端同步移除 renderProposal 及全部
  //    提案调用，保证「前端有 ≡ 合约有」双向对应，零提案残留。
  // ============================================================

  // ============================================================
  // 🟢 管理员：战斗参数热更面板（克制/稀有度/技能/连携强度）
  //    走 SanguoSetParams 全量提交：表单只改战斗系数，其余字段 =
  //    链上查询结果 + 废弃计费字段补 0（服务端 set_params 亦强制归零）。
  //    ⚠️ SanguoParams 带 deny_unknown_fields，响应里的 pay_token 必须
  //    剔除（它不属于 SanguoParams，是存储 PAYMENT_TOKEN 的镜像）。
  // ============================================================
  const SG_BP_DEFAULTS = {
    faction_counter_bp: 11500, faction_countered_bp: 9000, faction_neutral_bp: 10000,
    troop_counter_bp: 11000, troop_countered_bp: 10000, troop_neutral_bp: 10000,
    rarity_legend_bp: 11500, rarity_epic_bp: 10000, rarity_rare_bp: 10000, rarity_common_bp: 10000,
    power_flat_cap_bp: 3000, eff_lower_bound_bp: 5000,
    skill_strength_bp: 10000, bond_strength_bp: 10000,
  };
  const SG_BP_DEPRECATED_ZEROS = {
    single_paxi_fee: 0, pack3_paxi_fee: 0,
    single_prc_total: 0, single_prc_eco: 0, single_prc_burn: 0,
    pack3_prc_total: 0, pack3_prc_eco: 0, pack3_prc_burn: 0,
    ai_fee: [0, 0, 0, 0, 0], ai_reward: [0, 0, 0, 0, 0], ai_burn_pct_bp: 0,
    upgrade_fees: [0, 0, 0, 0],
    pvp_fee: 0, royale_entry_fee: 0, royale_reward_pct_bp: 0, royale_burn_pct_bp: 0,
    proposal_deposit: 0, voting_period: 0,
  };
  async function renderBattleParams(body) {
    if (!isSgAdmin()) { sanguoTab = 'draw'; renderSanguoTab(); return; }
    try { await loadParams(); } catch (e) {}
    const p = paramsCache || {};
    const eff = (k) => (p[k] != null && Number(p[k]) !== 0) ? Number(p[k]) : SG_BP_DEFAULTS[k];
    const rows = Object.keys(SG_BP_DEFAULTS).map((k) => `
      <div class="kv" style="align-items:center">
        <span class="k">${t('bp_' + k)}<br><span style="font-size:9px;color:#9fb3d1">${k} · ${t('bp_default')} ${SG_BP_DEFAULTS[k]}</span></span>
        <span class="v"><input class="input" id="bp_${k}" type="number" value="${eff(k)}" style="width:110px;text-align:right"></span>
      </div>`).join('');
    body.innerHTML = `
      <div class="card">
        <div class="card-title">⚙️ ${t('bp_title')}</div>
        <div class="desc">${t('bp_desc')}</div>
      </div>
      <div class="card">${rows}</div>
      <div class="card">
        <div class="card-title">${t('bp_json_title')}</div>
        <div class="desc">${t('bp_json_hint')}</div>
        <textarea id="bpJson" class="input" style="width:100%;min-height:180px;font-family:monospace;font-size:11px"></textarea>
        <button class="btn btn-primary" id="bpSave" style="margin-top:10px;width:100%">${t('bp_save')}</button>
        <div id="bpLog" style="margin-top:8px"></div>
      </div>`;
    // 剔除响应中不属于 SanguoParams 的键（deny_unknown_fields 会拒绝）
    const buildParams = () => {
      const obj = { ...SG_BP_DEPRECATED_ZEROS, ...p };
      delete obj.pay_token;
      // 🟢 交叉审计：响应里 stamina_pack_price 是字符串（query 层 s() 转换），
      //    链上 u128 只收 JSON 数字——不转换整条 SanguoSetParams 会被拒
      obj.stamina_pack_price = Number(obj.stamina_pack_price || 0);
      Object.keys(SG_BP_DEFAULTS).forEach((k) => {
        const el = document.getElementById('bp_' + k);
        if (el) obj[k] = Number(el.value || 0);
      });
      return obj;
    };
    const fillJson = () => { $('bpJson').value = JSON.stringify(buildParams(), null, 2); };
    fillJson();
    Object.keys(SG_BP_DEFAULTS).forEach((k) => {
      const el = document.getElementById('bp_' + k);
      if (el) el.onchange = fillJson;
    });
    $('bpSave').onclick = async () => {
      let obj;
      try { obj = JSON.parse($('bpJson').value); } catch (e) { showToast(t('bp_invalid_json'), 'error'); return; }
      if (!state.wallet) { showToast(t('connect_first'), 'error'); return; }
      showBusy(t('doing'));
      try {
        // 管理员消息不走会话验签（set_params 仅校验 is_admin），直接主钱包签名
        const hash = await execContract({ sanguo_set_params: { params: obj } }, [], '');
        await waitForTx(hash);
        paramsCache = null;   // 强制下次重拉，避免展示旧值
        showToast(t('bp_save_ok'), 'success');
        $('bpLog').innerHTML = `<div class="hint ok">✅ ${t('bp_save_ok')}</div>`;
        renderSanguoTab();
      } catch (e) {
        $('bpLog').innerHTML = `<div class="hint err">❌ ${esc(e.message || e)}</div>`;
        showToast(t('fail_prefix') + (e.message || e), 'error');
      } finally { hideBusy(); }
    };
  }

  // ============================================================
  // PVP 1v1
  // ============================================================
  async function renderPvp(body) {
    await loadParams();
    if (state.wallet) await loadSanguoCards();
    sanguoPicked = [];
    body.innerHTML = `
      <div class="card lobby-hero">
        <div class="card-title">🆚 ${t('pvp_title')}</div>
        <div class="desc">${t('pvp_desc')}</div>
      </div>
      <div class="card">
        <div class="card-title">${t('pvp_create')}</div>
        <input id="sgPvpOpp" class="input" placeholder="${t('pvp_opponent')}">
        <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;color:#9fb3d1">
          <input type="checkbox" id="sgPvpPublic"> ${t('pvp_public')}
        </label>
        <div style="font-size:12px;color:#9fb3d1;margin-top:8px">${t('pick_title')}（${t('need_nine')}）</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0" id="sgPvpPick"></div>
        <button class="btn btn-primary" id="sgPvpCreate" style="width:100%">${t('pvp_create')}</button>
      </div>
      <div class="card" id="sgActCard" style="display:none">
        <div class="card-title">${t('pick_title')}（${t('need_nine')}）</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0" id="sgActPick"></div>
        <button class="btn btn-primary" id="sgActGo" style="width:100%">${t('ok_short')}</button>
      </div>
      <div class="card">
        <div class="card-title">${t('pvp_list')}</div>
        <div id="sgPvpList"></div>
      </div>`;
    sanguoRenderPicker('sgPvpPick', 9);
    $('sgPvpCreate').onclick = () => doCreatePvp();
    const list = $('sgPvpList');
    try {
      const r = await queryContract({ sanguo_pvp_list: { player: null, status: null, limit: 50 } });
      const ms = (r && r.matches) || [];
      if (!ms.length) list.innerHTML = `<div class="hint">${t('none_label')}</div>`;
      else {
        list.innerHTML = ms.map((m) => {
          const isChallenger = state.wallet && m.challenger === state.wallet.address;
          const isOpponent = state.wallet && m.opponent === state.wallet.address;
          const winner = m.winner || '';
          const isWinner = state.wallet && winner === state.wallet.address;
          const buttons = [];
          if (m.status === 'waiting') {
            if (isOpponent || (m.is_public && !isChallenger)) buttons.push(`<button class="btn btn-sm btn-primary" data-accept="${m.match_id}">${t('pvp_accept')}</button>`);
            if (isChallenger) buttons.push(`<button class="btn btn-sm btn-ghost" data-cancel="${m.match_id}">${t('pvp_cancel')}</button>`);
          }
          if (m.status === 'finished' && isWinner && !m.reward_claimed) buttons.push(`<button class="btn btn-sm btn-gold" data-claim="${m.match_id}">${t('pvp_claim')}</button>`);
          return `<div style="border-bottom:1px solid #1c2740;padding:6px 0">
            <div style="font-size:12px;font-weight:700;color:#fff">${t('match_id_label')}: ${esc(m.match_id)}</div>
            <div style="font-size:11px;color:#9fb3d1">${t('status_label')}: ${m.status} · ${t('opponent_label')}: ${m.opponent ? esc(sgShortAddr(m.opponent)) : (m.is_public ? t('pvp_public') : '—')}</div>
            <div style="display:flex;gap:4px;margin-top:4px">${buttons.join('')}</div>
          </div>`;
        }).join('');
        list.querySelectorAll('button[data-accept]').forEach((b) => { b.onclick = () => doAcceptPvp(b.dataset.accept); });
        list.querySelectorAll('button[data-cancel]').forEach((b) => { b.onclick = () => doCancelPvp(b.dataset.cancel); });
        list.querySelectorAll('button[data-claim]').forEach((b) => { b.onclick = () => doClaimPvp(b.dataset.claim); });
      }
    } catch (e) { list.innerHTML = `<div class="hint err">${esc(e.message || e)}</div>`; }
  }

  async function doCreatePvp() {
    if (sanguoPicked.length !== 9) { showToast(t('need_nine'), 'error'); return; }
    if (!sgTeamCostOk(sanguoPicked.slice())) return;
    const opponent = ($('sgPvpOpp') || {}).value ? $('sgPvpOpp').value.trim() : '';
    const isPublic = ($('sgPvpPublic') || {}).checked;
    if (!isPublic && !opponent) { showToast(t('pvp_opponent'), 'error'); return; }
    // 🟢 安全审计 Y-2：前置校验对手地址（bech32 格式 + 禁自挑战），
    //    避免非法地址到链上 addr_validate 才拒 → DeliverTx 失败白烧 gas
    if (!isPublic) {
      if (!ADDR_RE.test(opponent)) { showToast(t('pvp_opponent'), 'error'); return; }
      if (state.wallet && opponent === state.wallet.address) { showToast(t('pvp_opponent'), 'error'); return; }
    }
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    try { await loadParams(); } catch (e) { showToast(t('params_err'), 'error'); return; }
    const p = requireParams();
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoBattlePvp', { mode: 'single', action: 'create', opponent: isPublic ? '' : opponent, card_ids: sanguoPicked.slice(), public: isPublic }, { action: 'battle_pvp', spend: 0, extra: 'single:create:' });
      showToast(t('free_entry_ok'), 'success');
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }
  async function doAcceptPvp(matchId) {
    sgPendingAction = 'accept_pvp'; sgPendingId = matchId; sanguoPicked = [];
    const card = document.getElementById('sgActCard');
    if (card) { card.style.display = ''; sanguoRenderPicker('sgActPick', 9); }
    const go = document.getElementById('sgActGo');
    if (go) go.onclick = () => doPendingConfirm();
  }
  async function doPendingConfirm() {
    if (sanguoPicked.length !== 9) { showToast(t('need_nine'), 'error'); return; }
    if (!sgTeamCostOk(sanguoPicked.slice())) return;
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    try { await loadParams(); } catch (e) { showToast(t('params_err'), 'error'); return; }
    const p = requireParams();
    showBusy(t('doing'));
    try {
      if (sgPendingAction === 'accept_pvp') {
        const res = await sanguoExec('SanguoBattlePvp', { mode: 'single', action: 'accept', match_id: sgPendingId, card_ids: sanguoPicked.slice() }, { action: 'battle_pvp', spend: 0, extra: 'single:accept:' + sgPendingId });
        captureSkillLogFromTx('pvp:' + sgPendingId, res); // V2.1：缓存技能触发回放
        showToast(t('free_entry_ok'), 'success');
        // 🟢 前端新增：对战竞技场（双方出牌 + 胜负）
        try { await showPvpBattle(sgPendingId); } catch (_) { /* 展示失败不影响主流程 */ }
      } else if (sgPendingAction === 'join_royale') {
        await sanguoExec('SanguoBattlePvp', { mode: 'royale', action: 'join', royale_id: sgPendingId, card_ids: sanguoPicked.slice() }, { action: 'battle_pvp', spend: 0, extra: 'royale:join:' + sgPendingId });
        showToast(t('free_entry_ok'), 'success');
      }
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }
  async function doCancelPvp(matchId) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoBattlePvp', { mode: 'single', action: 'cancel', match_id: matchId }, { action: 'battle_pvp', spend: 0, extra: 'single:cancel:' + matchId });
      showToast(t('cancel_ok'), 'success');
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }
  async function doClaimPvp(matchId) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      const res = await sanguoExec('SanguoBattlePvp', { mode: 'single', action: 'claim', match_id: matchId }, { action: 'battle_pvp', spend: 0, extra: 'single:claim:' + matchId });
      sgClaimToast(res.tx, 'claim_ok');
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }

  // ============================================================
  // 混战（4-6 人）
  // ============================================================
  async function renderRoyale(body) {
    await loadParams();
    if (state.wallet) await loadSanguoCards();
    sanguoPicked = [];
    body.innerHTML = `
      <div class="card lobby-hero">
        <div class="card-title">🔥 ${t('royale_title')}</div>
        <div class="desc">${t('royale_desc')}</div>
      </div>
      <div class="card">
        <div class="card-title">${t('royale_create')}</div>
        <select id="sgRoyaleSize" class="input">
          <option value="4">4</option><option value="5">5</option><option value="6">6</option>
        </select>
        <div style="font-size:12px;color:#9fb3d1;margin-top:8px">${t('pick_title')}（${t('need_nine')}）</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0" id="sgRoyalePick"></div>
        <button class="btn btn-primary" id="sgRoyaleCreate" style="width:100%">${t('royale_create')}</button>
      </div>
      <div class="card" id="sgActCard" style="display:none">
        <div class="card-title">${t('pick_title')}（${t('need_nine')}）</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0" id="sgActPick"></div>
        <button class="btn btn-primary" id="sgActGo" style="width:100%">${t('ok_short')}</button>
      </div>
      <div class="card">
        <div class="card-title">${t('royale_list')}</div>
        <div id="sgRoyaleList"></div>
      </div>`;
    sanguoRenderPicker('sgRoyalePick', 9);
    $('sgRoyaleCreate').onclick = () => doCreateRoyale();
    const list = $('sgRoyaleList');
    try {
      const r = await queryContract({ sanguo_royale_list: { status: null, limit: 50 } });
      const rs = (r && r.royales) || [];
      if (!rs.length) list.innerHTML = `<div class="hint">${t('none_label')}</div>`;
      else {
        list.innerHTML = rs.map((m) => {
          const isPlayer = state.wallet && m.players.includes(state.wallet.address);
          const winner = m.winner || '';
          const isWinner = state.wallet && winner === state.wallet.address;
          const buttons = [];
          if (m.status === 'waiting' && !isPlayer) buttons.push(`<button class="btn btn-sm btn-primary" data-join="${m.royale_id}">${t('royale_join')}</button>`);
          if (m.status === 'full') buttons.push(`<button class="btn btn-sm btn-primary" data-settle="${m.royale_id}">${t('royale_settle')}</button>`);
          if (m.status === 'finished' && isWinner && !m.reward_claimed) buttons.push(`<button class="btn btn-sm btn-gold" data-claim="${m.royale_id}">${t('royale_claim')}</button>`);
          return `<div style="border-bottom:1px solid #1c2740;padding:6px 0">
            <div style="font-size:12px;font-weight:700;color:#fff">${t('match_id_label')}: ${esc(m.royale_id)}</div>
            <div style="font-size:11px;color:#9fb3d1">${t('status_label')}: ${m.status} · ${t('royale_size')}: ${m.size} · ${m.players.length}/${m.size}</div>
            <div style="display:flex;gap:4px;margin-top:4px">${buttons.join('')}</div>
          </div>`;
        }).join('');
        list.querySelectorAll('button[data-join]').forEach((b) => { b.onclick = () => doJoinRoyale(b.dataset.join); });
        list.querySelectorAll('button[data-settle]').forEach((b) => { b.onclick = () => doSettleRoyale(b.dataset.settle); });
        list.querySelectorAll('button[data-claim]').forEach((b) => { b.onclick = () => doClaimRoyale(b.dataset.claim); });
      }
    } catch (e) { list.innerHTML = `<div class="hint err">${esc(e.message || e)}</div>`; }
  }

  async function doCreateRoyale() {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    if (sanguoPicked.length !== 9) { showToast(t('need_nine'), 'error'); return; }
    if (!sgTeamCostOk(sanguoPicked.slice())) return;
    const size = Number(($('sgRoyaleSize') || {}).value || 4);
    try { await loadParams(); } catch (e) { showToast(t('params_err'), 'error'); return; }
    const p = requireParams();
    showBusy(t('doing'));
    try {
      await sanguoExec('SanguoBattlePvp', { mode: 'royale', action: 'create', size, card_ids: sanguoPicked.slice() }, { action: 'battle_pvp', spend: 0, extra: 'royale:create:' });
      showToast(t('free_entry_ok'), 'success');
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }
  async function doJoinRoyale(royaleId) {
    sgPendingAction = 'join_royale'; sgPendingId = royaleId; sanguoPicked = [];
    const card = document.getElementById('sgActCard');
    if (card) { card.style.display = ''; sanguoRenderPicker('sgActPick', 9); }
    const go = document.getElementById('sgActGo');
    if (go) go.onclick = () => doPendingConfirm();
  }
  async function doSettleRoyale(royaleId) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      const res = await sanguoExec('SanguoBattlePvp', { mode: 'royale', action: 'settle', royale_id: royaleId }, { action: 'battle_pvp', spend: 0, extra: 'royale:settle:' + royaleId });
      captureSkillLogFromTx('royale:' + royaleId, res); // V2.1：缓存技能触发回放（多场聚合）
      showToast(t('settle_ok'), 'success');
      // 🟢 前端新增：混战竞技场（多方出牌 + 胜者）
      try { await showRoyaleBattle(royaleId); } catch (_) { /* 展示失败不影响主流程 */ }
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }
  async function doClaimRoyale(royaleId) {
    try { await requireSanguo(); } catch (e) { showToast(e.message, 'error'); return; }
    showBusy(t('doing'));
    try {
      const res = await sanguoExec('SanguoBattlePvp', { mode: 'royale', action: 'claim', royale_id: royaleId }, { action: 'battle_pvp', spend: 0, extra: 'royale:claim:' + royaleId });
      sgClaimToast(res.tx, 'claim_ok');
      renderSanguoTab();
    } catch (e) { showToast(t('fail_prefix') + (e.message || e), 'error'); }
    finally { hideBusy(); }
  }

  // ============================================================
  // 新增前端展示：图鉴 / 卡牌详情 / 对战竞技场 / 头部统计联动
  // ⚠️ 仅改渲染层；以下函数不发起任何合约写操作，
  //    所有 sanguoExec / queryContract 调用均复用既有逻辑或只读查询。
  // ============================================================
  let sgAiStats = null;     // 来自 sanguo_ai_stats {total,wins,...}
  let sgFragCache = null;   // 碎片总数（来自 sanguo_fragments）
  let currentDetailCard = null; // 当前卡牌详情弹窗对应的卡

  // 稀有度 → CSS 类（对应 index.html 的 .rarity-*）
  function rarityClass(r) {
    return { legend: 'rarity-legend', epic: 'rarity-epic', rare: 'rarity-rare', common: 'rarity-common' }[r] || '';
  }

  // ---- 卡牌详情弹窗 ----
  // 根据 card_id 打开「我的卡」详情（可升星 / 升级 / 分解）
  function openCardDetailFromId(cardId) {
    const card = userCards.find((c) => c.card_id === cardId);
    if (!card) return;
    // 🟢 2026-09-29：链上卡不带 title/identity（阵营），按名字查模板补齐，
    //    让「我的卡」详情与图鉴详情显示同样的阵营信息。
    const tpl = sgTplByName(card.name) || {};
    openCardDetail({
      ...card,
      title: card.title || tpl.title || '',
      identity: card.identity || tpl.identity || '',
    }, true);
  }
  window.openCardDetailFromId = openCardDetailFromId;

  // 根据武将名打开图鉴卡详情（只读，不可养成）
  function openCodexCard(name) {
    const tpl = CARD_TEMPLATES.find((t) => t.name === name);
    if (!tpl) return;
    openCardDetail({
      card_id: tpl.name, name: tpl.name, rarity: tpl.rarity,
      attack: tpl.attack, defense: tpl.defense, star: 1, level: 0,
      title: tpl.title, identity: tpl.identity,
    }, false);
  }
  window.openCodexCard = openCodexCard;

  function openCardDetail(card, owned) {
    currentDetailCard = card;
    const img = getCardImage(card.name);
    const col = rarityColor(card.rarity);
    const dImg = $('detailImg'); if (dImg) { dImg.src = img || ''; dImg.style.display = img ? '' : 'none'; }
    const dName = $('detailName'); if (dName) { dName.textContent = card.name || '—'; dName.style.color = col; }
    const dSub = $('detailSub'); if (dSub) dSub.textContent = card.identity || card.title || '';
    const dRar = $('detailRarity'); if (dRar) { dRar.textContent = rarityLabel(card.rarity); dRar.style.color = col; }
    const dId = $('detailIdentity'); if (dId) dId.textContent = card.identity || card.title || '—';
    const dAtk = $('detailAtk'); if (dAtk) dAtk.textContent = (card.attack != null) ? card.attack : '—';
    const dDef = $('detailDef'); if (dDef) dDef.textContent = (card.defense != null) ? card.defense : '—';
    const dPow = $('detailPower'); if (dPow) dPow.textContent = power(card);
    const dStar = $('detailStar'); if (dStar) dStar.textContent = '★' + (card.star || 1) + (card.level ? ' Lv' + card.level : '');
    const dDesc = $('detailDesc');
    if (dDesc) dDesc.textContent = tf('detail_stats', {
      identity: card.identity || '',
      title: card.title ? tf('detail_title_wrap', { t: card.title }) : '',
      atk: card.attack != null ? card.attack : '?',
      def: card.defense != null ? card.defense : '?',
      pow: power(card),
    });
    // 🟢 战斗属性补全（2026-10-14）：兵种 / 技能（3★ 解锁态）/ 连携
    const tplB = sgTplByName(card.name) || {};
    let extra = '';
    if (tplB.troop) extra += `<div style="font-size:11px;color:#9fb3d1;margin-top:4px">⚔️ ${t('troop_' + tplB.troop)}</div>`;
    const skD = tplB.skill_id ? sgFindSkill(tplB.skill_id) : null;
    if (skD) {
      const st = card.star || 1;
      extra += `<div style="font-size:11px;color:${st >= 3 ? '#ffd700' : '#9fb3d1'};margin-top:2px">✦ ${st >= 3 ? sgSkillDesc(tplB.skill_id) : tf('skill_locked', { name: skD[0] })}</div>`;
    }
    if (tplB.bonds && tplB.bonds.length) extra += `<div style="font-size:10px;color:#9fb3d1;margin-top:2px">🔗 ${t('bond_label')}：${esc(sgBondNames(tplB.bonds))}</div>`;
    let hostB = document.getElementById('detailBattle');
    if (extra) {
      if (!hostB && dDesc && dDesc.parentNode) {
        hostB = document.createElement('div');
        hostB.id = 'detailBattle';
        dDesc.parentNode.insertBefore(hostB, dDesc.nextSibling);
      }
      if (hostB) hostB.innerHTML = extra;
    } else if (hostB) {
      hostB.innerHTML = '';
    }
    // 🟢「我的卡牌」弹窗只展示参数：养成按钮统一放到「养成」页，这里始终隐藏。
    const actions = document.querySelector('#cardDetailModal .star-actions');
    if (actions) actions.style.display = 'none';
    const modal = $('cardDetailModal');
    if (modal) modal.classList.add('active');
  }
  window.openCardDetail = openCardDetail;

  function closeCardDetail() {
    const modal = $('cardDetailModal');
    if (modal) modal.classList.remove('active');
    currentDetailCard = null;
  }
  window.closeCardDetail = closeCardDetail;

  // 详情弹窗内的养成按钮：复用既有 do* 逻辑（已含无感签名 + 重渲染）
  async function _refreshDetail(cardId) {
    if (state.wallet) { try { await loadSanguoCards(); } catch (e) {} }
    const card = userCards.find((c) => c.card_id === cardId);
    if (card) openCardDetail(card, true);
    else closeCardDetail(); // 已分解（卡不存在）
  }
  async function detailStarUp() {
    if (!currentDetailCard) return;
    const cid = currentDetailCard.card_id;
    await doStarUp(cid, false); await _refreshDetail(cid);
  }
  window.detailStarUp = detailStarUp;
  async function detailStarUpFrag() {
    if (!currentDetailCard) return;
    const cid = currentDetailCard.card_id;
    await doStarUp(cid, true); await _refreshDetail(cid);
  }
  window.detailStarUpFrag = detailStarUpFrag;
  async function detailUpgrade() {
    if (!currentDetailCard) return;
    const cid = currentDetailCard.card_id;
    await doUpgrade(cid); await _refreshDetail(cid);
  }
  window.detailUpgrade = detailUpgrade;
  async function detailDecompose() {
    if (!currentDetailCard) return;
    const cid = currentDetailCard.card_id;
    await doDecompose(cid); closeCardDetail();
  }
  window.detailDecompose = detailDecompose;

  // ---- 老版风格：我的卡牌网格内联按钮（不经弹窗直接养成）----
  // 分解是销毁性操作（卡没了换碎片），网格里按钮小、易误触，加一次确认。
  window.sgQuickUpgrade = (cid) => doUpgrade(cid);
  window.sgQuickStarUp = (cid) => doStarUp(cid, false);
  window.sgQuickDecompose = (cid) => {
    if (!confirm(t('decompose_confirm'))) return;
    doDecompose(cid);
  };

  // ---- 卡牌图鉴 ----
  // 图鉴筛选状态（P1-9：搜索 / 稀有度 / 排序）
  let _codexFilter = { q: '', rarity: 'all', sort: 'power' };

  function renderCodexToolbar() {
    let bar = $('codexToolbar');
    if (bar) return;
    const modal = $('codexModal');
    if (!modal) return;
    bar = document.createElement('div');
    bar.id = 'codexToolbar';
    bar.className = 'codex-toolbar';
    const allLabel = (window.HUB_LANG === 'en') ? 'All' : '全部';
    bar.innerHTML = `
      <input id="codexSearch" class="codex-search" placeholder="${esc(t('codex_search'))}" />
      <div class="codex-filters">
        ${['all', 'legend', 'epic', 'rare', 'common'].map((r) =>
          `<button class="codex-fbtn${r === 'all' ? ' on' : ''}" data-r="${r}">${r === 'all' ? allLabel : rarityLabel(r)}</button>`).join('')}
      </div>
      <select id="codexSort" class="codex-sort">
        <option value="power">${esc(t('sort_power'))}</option>
        <option value="atk">${esc(t('sort_atk'))}</option>
        <option value="def">${esc(t('sort_def'))}</option>
        <option value="name">${esc(t('sort_name'))}</option>
      </select>`;
    const h2 = modal.querySelector('h2');
    if (h2) h2.insertAdjacentElement('afterend', bar);
    else modal.querySelector('.modal').insertBefore(bar, $('codexProgress'));
    const search = $('codexSearch');
    if (search) search.oninput = (e) => { _codexFilter.q = (e.target.value || '').trim().toLowerCase(); _renderCodexGridFromCache(); };
    const sort = $('codexSort');
    if (sort) sort.onchange = (e) => { _codexFilter.sort = e.target.value; _renderCodexGridFromCache(); };
    bar.querySelectorAll('.codex-fbtn').forEach((b) => {
      b.onclick = () => {
        _codexFilter.rarity = b.dataset.r;
        bar.querySelectorAll('.codex-fbtn').forEach((x) => x.classList.toggle('on', x === b));
        _renderCodexGridFromCache();
      };
    });
  }

  async function _renderCodexGridFromCache() {
    const templates = await loadSanguoTemplates();
    _renderCodexGrid(templates);
  }

  function _renderCodexGrid(templates) {
    const grid = $('codexContent');
    if (!grid) return;
    const ownedNames = new Set(userCards.map((c) => c.name));
    let list = templates.slice();
    if (_codexFilter.rarity !== 'all') list = list.filter((tpl) => tpl.rarity === _codexFilter.rarity);
    if (_codexFilter.q) list = list.filter((tpl) =>
      (tpl.name + ' ' + (tpl.identity || '') + ' ' + (tpl.title || '')).toLowerCase().includes(_codexFilter.q));
    if (_codexFilter.sort === 'power') list.sort((a, b) => power(b) - power(a));
    else if (_codexFilter.sort === 'atk') list.sort((a, b) => Number(b.attack) - Number(a.attack));
    else if (_codexFilter.sort === 'def') list.sort((a, b) => Number(b.defense) - Number(a.defense));
    else if (_codexFilter.sort === 'name') list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!list.length) { grid.innerHTML = `<div class="hint">${esc(t('codex_empty'))}</div>`; return; }
    grid.innerHTML = list.map((tpl, i) => {
      const img = getCardImage(tpl.name);
      const cls = rarityClass(tpl.rarity);
      const have = ownedNames.has(tpl.name);
      // 🟢 阵营行与「我的卡」保持一致（2026-09-29）
      const idt = (tpl.identity || tpl.faction) || '';
      const ffHtml = idt ? `<div class="ff" style="color:${sgFactionColor(idt)}">${esc(idt)}</div>` : '';
      const ttHtml = tpl.title ? `<div class="tt">${esc(tpl.title)}</div>` : '';
      // 🟢 图鉴战斗属性（2026-10-14）：兵种 + 技能名
      const btTag = tpl.troop
        ? `<div style="font-size:9px;color:#9fb3d1">⚔️ ${t('troop_' + tpl.troop)}${tpl.skill_id && SG_SKILLS[tpl.skill_id] ? ' · ✦' + esc(SG_SKILLS[tpl.skill_id][0]) : ''}</div>`
        : '';
      return `<div class="codex-card ${cls} ${have ? 'owned' : 'locked'} sg-fade-in" style="animation-delay:${Math.min(i * 18, 420)}ms" onclick="openCodexCard('${esc(tpl.name)}')">
        ${have ? '' : `<div class="sg-card-lv">${t('codex_not_owned')}</div>`}
        <div class="cc-img"><img data-src="${img}" loading="lazy" decoding="async" onerror="this.style.display='none'"></div>
        <div class="cc-foot"><div class="nm">${esc(tpl.name)}</div>${ttHtml}${ffHtml}${btTag}<div class="rr">${rarityLabel(tpl.rarity)} · ${t('power_label')} ${power(tpl)}</div></div>
      </div>`;
    }).join('');
    sgObserveLazyImages(grid);   // 图鉴卡图懒加载
  }

  async function openCodex() {
    const templates = await loadSanguoTemplates();
    renderCodexToolbar();
    _renderCodexGrid(templates);
    const ownedNames = new Set(userCards.map((c) => c.name));
    const total = templates.length;
    const ownedCount = templates.filter((tpl) => ownedNames.has(tpl.name)).length;
    const prog = $('codexProgress');
    if (prog) {
      const pct = total ? Math.round((ownedCount / total) * 100) : 0;
      // 🟢 收集度进度条（20261013-2）：文本 → 进度条 + 文本
      prog.innerHTML = `<div class="codex-bar"><span style="width:${pct}%"></span></div>`
        + `<div class="codex-bar-txt">${tf('codex_progress', { own: ownedCount, total })} · ${t('codex_collect')} ${pct}%</div>`;
    }
    const modal = $('codexModal');
    if (modal) modal.classList.add('active');
    sgObserveLazyImages($('codexContent'));   // 弹窗显示后再触发可见区域懒加载
  }
  window.openCodex = openCodex;

  function closeCodex() {
    const modal = $('codexModal');
    if (modal) modal.classList.remove('active');
  }
  window.closeCodex = closeCodex;

  // ---- 对战竞技场 ----
  // 解析 "[210, 180, 195]" 形式的战力数组
  function parsePowers(str) {
    if (!str) return [];
    return String(str).replace(/[\[\]]/g, '').split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
  }
  // 用战力还原最接近的模板（用于展示 AI 出牌，纯前端展示用）
  function bestMatchTemplate(p) {
    let best = null, bd = Infinity;
    for (const tpl of CARD_TEMPLATES) {
      const d = Math.abs((tpl.attack + tpl.defense) - p);
      if (d < bd) { bd = d; best = tpl; }
    }
    return best;
  }
  // 批量按 card_id 取卡（任意玩家均可，复用 sanguo_card 只读查询）
  async function cardsFromIds(ids) {
    const list = await Promise.all((ids || []).map(async (id) => {
      try {
        const c = await queryContract({ sanguo_card: { card_id: id } });
        return c ? { name: c.name, rarity: c.rarity, power: power(c) } : { name: id, rarity: 'common', power: 0 };
      } catch (e) { return { name: id, rarity: 'common', power: 0 }; }
    }));
    return list;
  }
  // 迷你卡（竞技场用）
  function miniCardHtml(c) {
    const img = c.img || getCardImage(c.name) || '';
    const col = rarityColor(c.rarity);
    // 🟢 兵种角标（2026-10-14）：战斗展示按模板补兵种
    const tplM = sgTplByName(c.name) || {};
    const troopTag = tplM.troop ? `<div style="position:absolute;bottom:0;left:0;background:rgba(13,10,12,0.78);color:#9fb3d1;font-size:7px;padding:0 2px;border-top-right-radius:3px">${t('troop_' + tplM.troop)}</div>` : '';
    const tag = c.ai ? '<div style="position:absolute;top:0;left:0;background:#8b2f1a;color:#fff;font-size:8px;padding:0 3px;border-bottom-right-radius:4px">AI</div>'
                     : (c.win ? '<div style="position:absolute;top:0;right:0;background:#b8860b;color:#0d0a0c;font-size:8px;padding:0 3px;border-bottom-left-radius:4px">👑</div>' : '');
    return `<div class="mini-card" style="position:relative;border-color:${col}">
      ${tag}
      <img src="${img}" loading="lazy" decoding="async" onerror="this.style.display='none'">
      <div class="mc-nm">${esc(c.name || '?')}</div>
      ${c.power != null ? `<div style="font-size:8px;text-align:center;color:${col};padding-bottom:1px">⚔ ${c.power}</div>` : ''}
      ${troopTag}
    </div>`;
  }
  // 🟢 连携横幅（S3 单档封顶，纯前端展示，不含 bond_strength 缩放）
  function sgBondBanner(names, label) {
    const b = sgBondActive(names || []);
    return b ? `<div class="side-label" style="font-size:10px;color:#ffd700">🔗 ${esc(label || '')}${tf('bond_active', { name: b.name, bp: (b.bp / 100).toFixed(0), cnt: b.cnt, need: b.need })}</div>` : '';
  }
  // 通用竞技场渲染：opts.sides 或 opts.you/opts.opp；result ∈ win|lose|draw
  function showBattle(opts) {
    const arena = $('battleArena');
    if (!arena) return;
    let sidesHtml;
    if (opts.sides && opts.sides.length) {
      sidesHtml = opts.sides.map((s) => `
        <div class="side-label">${esc(s.label || '—')}${t('battle_deployed')}</div>
        <div class="side-cards">${(s.cards || []).map(miniCardHtml).join('') || '<span class="hint">—</span>'}</div>
        ${sgBondBanner((s.cards || []).map((c) => c.name), s.label)}`).join('');
    } else {
      const you = (opts.you || []).map((c) => (Object.assign({}, c, { win: opts.result === 'win' })));
      const opp = (opts.opp || []).map((c) => (Object.assign({}, c, { win: opts.result === 'lose' })));
      sidesHtml = `
        <div class="side-label">${esc(opts.youLabel || t('battle_you'))}${t('battle_deployed')}</div>
        <div class="side-cards">${you.map(miniCardHtml).join('') || '<span class="hint">—</span>'}</div>
        ${sgBondBanner(you.map((c) => c.name), opts.youLabel || t('battle_you'))}
        <div class="side-label">${esc(opts.oppLabel || t('battle_opp'))}${t('battle_deployed')}</div>
        <div class="side-cards">${opp.map(miniCardHtml).join('') || '<span class="hint">—</span>'}</div>
        ${sgBondBanner(opp.map((c) => c.name), opts.oppLabel || t('battle_opp'))}`;
    }
    const resultClass = opts.result === 'win' ? 'win' : opts.result === 'lose' ? 'lose' : 'draw';
    const resultText = opts.result === 'win' ? t('battle_win') : opts.result === 'lose' ? t('battle_lose') : t('battle_draw');
    const rewardHtml = (opts.fragReward && opts.fragReward.trim() && opts.fragReward !== 'common:0,rare:0,epic:0,legend:0')
      ? `<div class="side-label battle-reward">🧩 ${tf('battle_frag_reward', { frag: opts.fragReward })}</div>`
      : ((opts.reward != null && Number(opts.reward) > 0) ? `<div class="side-label battle-reward">${tf('battle_reward', { amt: opts.reward })}</div>` : '');
    const rwHtml = (opts.roundWins !== null && opts.roundWins !== undefined && opts.roundWins !== '') ? `<div class="side-label">${tf('battle_rounds', { n: opts.roundWins })}</div>` : '';
    arena.innerHTML = `
      <div class="vs-banner">${t('battle_result_title')}</div>
      ${sidesHtml}
      ${rwHtml}${rewardHtml}
      <div class="final-result ${resultClass} sg-fade-in">${resultText}</div>`;
    arena.classList.add('show');
    try { arena.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
  }
  window.showBattle = showBattle;

  // AI 对战：从交易事件还原双方出牌 + 胜负 + 奖励
  // ---- Q3：9v9 三组分组亮牌 ----
  function chunk3(arr) { arr = arr || []; return [[0, 1, 2], [3, 4, 5], [6, 7, 8]].map((idx) => idx.map((i) => arr[i]).filter(Boolean)); }
  // 解析链上 group_scores 事件（"2-1-0" → [2,1,0]），格式不符返回 null
  function parseGroupScores(s) {
    if (!s || typeof s !== 'string') return null;
    const parts = s.split('-').map((x) => Number(x));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return parts;
  }
  function groupedBattleHtml(opts) {
    const youGroups = chunk3(opts.you.cards);
    const oppGroups = chunk3(opts.opp.cards);
    const ga = opts.ga || [0, 0, 0];
    const gb = opts.gb || [0, 0, 0];
    let rows = '';
    for (let g = 0; g < 3; g++) {
      const ay = ga[g] || 0, by = gb[g] || 0;
      const cls = ay > by ? 'win' : by > ay ? 'lose' : 'draw';
      const txt = ay > by ? t('group_win') : by > ay ? t('group_lose') : t('group_draw');
      rows += `
        <div class="grp-row">
          <div class="grp-side"><div class="grp-tag">${tf('battle_group', { n: g + 1 })}</div>${youGroups[g].map(miniCardHtml).join('') || '<span class="hint">—</span>'}</div>
          <div class="grp-vs">${ay}<span class="grp-colon">:</span>${by}</div>
          <div class="grp-side">${oppGroups[g].map(miniCardHtml).join('') || '<span class="hint">—</span>'}</div>
          <div class="grp-res"><span class="grp-badge ${cls}">${txt}</span></div>
        </div>`;
    }
    const totalA = ga[0] + ga[1] + ga[2], totalB = gb[0] + gb[1] + gb[2];
    const resultClass = opts.result === 'win' ? 'win' : opts.result === 'lose' ? 'lose' : 'draw';
    const resultText = opts.result === 'win' ? t('battle_win') : opts.result === 'lose' ? t('battle_lose') : t('battle_draw');
    const rewardHtml = (opts.fragReward && opts.fragReward.trim() && opts.fragReward !== 'common:0,rare:0,epic:0,legend:0')
      ? `<div class="side-label battle-reward">🧩 ${tf('battle_frag_reward', { frag: opts.fragReward })}</div>`
      : ((opts.reward != null && Number(opts.reward) > 0) ? `<div class="side-label battle-reward">${tf('battle_reward', { amt: opts.reward })}</div>` : '');
    const rwHtml = (opts.roundWins !== null && opts.roundWins !== undefined && opts.roundWins !== '') ? `<div class="side-label">${tf('battle_rounds', { n: opts.roundWins })}</div>` : '';
    return `
      <div class="vs-banner">${t('battle_result_title')}</div>
      <div class="grp-head"><span>${esc(opts.you.label)}</span><span class="grp-score">${totalA} : ${totalB}</span><span>${esc(opts.opp.label)}</span></div>
      ${sgBondBanner(opts.you.cards.map((c) => c.name), opts.you.label)}
      ${sgBondBanner(opts.opp.cards.map((c) => c.name), opts.opp.label)}
      ${rows}
      ${rwHtml}${rewardHtml}
      <div class="final-result ${resultClass} sg-fade-in">${resultText}</div>`;
  }
  function showGroupedBattle(opts) {
    const arena = $('battleArena'); if (!arena) return;
    arena.innerHTML = groupedBattleHtml(opts);
    arena.classList.add('show');
    try { arena.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
  }
  window.showGroupedBattle = showGroupedBattle;

  async function showAiBattleFromTx(tx, diff) {
    const ev = parseTxEvents(tx, ['result', 'player_powers', 'ai_powers', 'round_wins', 'reward', 'group_scores_a', 'group_scores_b', 'skill_log']);
    const result = (ev.result && ev.result[0]) || 'lose';
    const playerPowers = parsePowers(ev.player_powers && ev.player_powers[0]);
    const aiPowers = parsePowers(ev.ai_powers && ev.ai_powers[0]);
    const roundWins = (ev.round_wins && ev.round_wins[0]) || '';
    const rewardRaw = (ev.reward && ev.reward[0]) || '';
    // 🟢 合规化：链上 reward 现在是碎片字符串（如 "common:20,rare:0,..."），原样展示，不再按 TKCC 精度换算
    const fragReward = result === 'win' ? rewardRaw : '';
    // 我方出牌：优先链上出战顺序（9 张），回退前 9 张
    let orderIds = [];
    try { const bo = await queryContract({ sanguo_battle_order: { player: state.wallet.address } }); orderIds = (bo && bo.order) || []; } catch (e) {}
    let you = orderIds.map((id) => userCards.find((c) => c.card_id === id)).filter(Boolean);
    if (you.length < 9) you = userCards.slice(0, 9);
    you = you.slice(0, 9).map((c, i) => ({ name: c.name, rarity: c.rarity, power: (playerPowers.length === 9 && playerPowers[i] != null) ? playerPowers[i] : power(c) }));
    // 对手（AI）：用战力还原最接近模板作展示（9 张，带 AI 标记）
    const opp = aiPowers.map((p) => {
      const tpl = bestMatchTemplate(p);
      return { name: tpl ? tpl.name : t('battle_ai_general'), rarity: tpl ? tpl.rarity : 'common', power: p, ai: true };
    });
    // 🟢 9v9 三组：链上有 group_scores_a/b 则分组亮牌（与 PVP/混战一致），否则回退平铺
    const ga = parseGroupScores(ev.group_scores_a && ev.group_scores_a[0]);
    const gb = parseGroupScores(ev.group_scores_b && ev.group_scores_b[0]);
    if (ga && gb) {
      showGroupedBattle({ you: { label: t('battle_you'), cards: you }, opp: { label: tf('battle_ai_diff', { n: diff }), cards: opp }, ga, gb, result, roundWins, fragReward });
    } else {
      showBattle({ you, opp, result, youLabel: t('battle_you'), oppLabel: tf('battle_ai_diff', { n: diff }), roundWins, fragReward });
    }
    // V2.1：技能触发回放（A=你，B=AI）
    appendSkillLog($('battleArena'), ev.skill_log && ev.skill_log[0], t('battle_you'), tf('battle_ai_diff', { n: diff }));
  }
  window.showAiBattleFromTx = showAiBattleFromTx;

  // V2.1：技能触发回放——解析链上 skill_log 事件（JSON 数组），按 A/B 分边渲染时间线。
  // 链上字段：side(0/1)、card_name、skill_id、trigger(snake_case)、target(self_/opponent)、
  // team_wide、attack_bp、defense_bp、power_flat_bp。技能中文名取 SG_SKILLS 镜像表。
  function skillLogTimelineHtml(rawJson, labelA, labelB) {
    let logs = [];
    try {
      let s = rawJson || '[]';
      // ⚠️ 链上事件属性经 RPC 多以 base64 返回；且 parseTxEvents 仅在解码结果为纯 ASCII 时才采用，
      //    而 skill_log 的 JSON 含中文卡名 → 不会被自动解码。这里统一尝试 base64→UTF-8；
      //    若原串本就是明文 JSON（atob 抛错），则保留原串，两种来源都能正常解析。
      if (typeof s === 'string') {
        try {
          const bin = atob(s);
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          s = new TextDecoder('utf-8').decode(bytes);
        } catch (e) { /* 明文 JSON，保留原串 */ }
      }
      logs = JSON.parse(s);
    } catch (e) { logs = []; }
    const title = `<div class="side-label">${esc(t('skill_log_title'))}</div>`;
    if (!Array.isArray(logs) || logs.length === 0) {
      return `<div class="skill-log-wrap">${title}<div class="skill-log-empty">${esc(t('skill_log_empty'))}</div></div>`;
    }
    const tgtKey = (s) => (s === 'self_' ? 'tgt_self' : 'tgt_opponent');
    let rows = '';
    for (const l of logs) {
      const side = (l.side === 1) ? 1 : 0;
      const sideLabel = side === 0 ? (labelA || t('skill_log_side_a')) : (labelB || t('skill_log_side_b'));
      const sk = SG_SKILLS[l.skill_id];
      const skName = (sk && sk[0]) ? sk[0] : (l.card_name || l.skill_id || '—');
      const trg = l.trigger ? t('trg_' + l.trigger) : t('trg_on_battle_start');
      const tgt = t(tgtKey(l.target));
      const tw = l.team_wide ? ` · ${esc(t('skill_log_team_wide'))}` : '';
      const bp = [];
      if (l.attack_bp) bp.push(`攻 ${(l.attack_bp > 0 ? '+' : '')}${(l.attack_bp / 100).toFixed(0)}%`);
      if (l.defense_bp) bp.push(`防 ${(l.defense_bp > 0 ? '+' : '')}${(l.defense_bp / 100).toFixed(0)}%`);
      if (l.power_flat_bp) bp.push(`战力 ${(l.power_flat_bp > 0 ? '+' : '')}${(l.power_flat_bp / 100).toFixed(0)}%`);
      const bpTxt = bp.length ? `（${bp.join('，')}）` : '';
      rows += `
        <div class="skill-log-row side-${side}">
          <span class="sk-side ${side === 0 ? 'sk-a' : 'sk-b'}">${esc(sideLabel)}</span>
          <span class="sk-card">${esc(l.card_name || skName)}</span>
          <span class="sk-name">${esc(skName)}</span>
          <span class="sk-trg">${esc(trg)}</span>
          <span class="sk-tgt">→${esc(tgt)}${tw}</span>
          <span class="sk-bp">${esc(bpTxt)}</span>
        </div>`;
    }
    return `<div class="skill-log-wrap">${title}<div class="skill-log-list">${rows}</div></div>`;
  }
  /** 把技能触发回放追加进对战竞技场（不覆盖已有结果） */
  function appendSkillLog(arena, rawJson, labelA, labelB) {
    if (!arena) return;
    try { arena.insertAdjacentHTML('beforeend', skillLogTimelineHtml(rawJson, labelA, labelB)); } catch (e) {}
  }
  // V2.1：技能触发回放缓存（结算 tx 一次性携带，不落链上状态；本地缓存以便重看同一场）
  const sgSkillLogCache = {};
  function setSkillLogCache(key, raw) { if (key && raw) sgSkillLogCache[key] = raw; }
  function getSkillLogCache(key) { return sgSkillLogCache[key] || null; }
  /** 从结算 tx 抽取 skill_log 事件值并写入缓存（失败静默） */
  function captureSkillLogFromTx(key, res) {
    try {
      const sl = (res && res.tx) ? (parseTxEvents(res.tx, ['skill_log']).skill_log || [])[0] : null;
      if (sl) setSkillLogCache(key, sl);
    } catch (e) {}
  }

  // PVP：双方真实出牌（按 card_id 取卡）+ 胜负 + Q3 三组分组亮牌
  async function showPvpBattle(matchId) {
    const m = await queryContract({ sanguo_pvp: { match_id: matchId } });
    if (!m) return;
    const ch = await cardsFromIds(m.challenger_order || []);
    const op = await cardsFromIds(m.opponent_order || []);
    const winner = m.winner || '';
    let result = 'draw';
    if (winner) {
      if (state.wallet && winner === state.wallet.address) result = 'win';
      else if (state.wallet && (m.challenger === state.wallet.address || m.opponent === state.wallet.address)) result = 'lose';
    }
    // 🟢 Q3：链上返回 group_scores_a/b 则分组展示每组胜负，否则回退平铺
    const ga = m.group_scores_a || null;
    const gb = m.group_scores_b || null;
    if (ga && gb && ga.length === 3 && gb.length === 3) {
      showGroupedBattle({ you: { label: t('battle_challenger'), cards: ch }, opp: { label: t('battle_defender'), cards: op }, ga, gb, result });
    } else {
      showBattle({ you: ch, opp: op, youLabel: t('battle_challenger'), oppLabel: t('battle_defender'), result });
    }
    // V2.1：技能触发回放（A=挑战方，B=应战方；结算 tx 携带，缓存重看）
    appendSkillLog($('battleArena'), getSkillLogCache('pvp:' + matchId), t('battle_challenger'), t('battle_defender'));
  }
  window.showPvpBattle = showPvpBattle;

  // 混战：多方真实出牌 + 胜者 + Q3 每人 9 张分 3 组展示
  async function showRoyaleBattle(royaleId) {
    const r = await queryContract({ sanguo_royale: { royale_id: royaleId } });
    if (!r) return;
    const players = r.players || [];
    const orders = r.player_orders || [];
    const winner = r.winner || '';
    let result = 'draw';
    if (winner) {
      if (state.wallet && winner === state.wallet.address) result = 'win';
      else if (state.wallet && players.includes(state.wallet.address)) result = 'lose';
    }
    const arena = $('battleArena'); if (!arena) return;
    let html = `<div class="vs-banner">${t('battle_result_title')}</div>`;
    for (let i = 0; i < players.length; i++) {
      const cards = await cardsFromIds(orders[i] || []);
      const groups = chunk3(cards);
      const isMe = state.wallet && players[i] === state.wallet.address;
      const isWin = winner && players[i] === winner;
      const label = (isMe ? t('battle_you') : sgShortAddr(players[i])) + (isWin ? ' 👑' : '');
      html += `<div class="royale-side"><div class="side-label">${esc(label)}</div>`;
      for (let g = 0; g < 3; g++) {
        html += `<div class="grp-mini"><span class="grp-tag">${tf('battle_group', { n: g + 1 })}</span><div class="grp-side">${(groups[g] || []).map(miniCardHtml).join('') || '<span class="hint">—</span>'}</div></div>`;
      }
      html += `</div>`;
    }
    const resultClass = result === 'win' ? 'win' : result === 'lose' ? 'lose' : 'draw';
    const resultText = result === 'win' ? t('battle_win') : result === 'lose' ? t('battle_lose') : t('battle_draw');
    html += `<div class="final-result ${resultClass} sg-fade-in">${resultText}</div>`;
    arena.innerHTML = html;
    arena.classList.add('show');
    try { arena.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    // V2.1：混战为多场 1v1 聚合，A/B 为逐场对位标记（非"你/对手"），用中性标签
    appendSkillLog(arena, getSkillLogCache('royale:' + royaleId), t('skill_log_side_a'), t('skill_log_side_b'));
  }
  window.showRoyaleBattle = showRoyaleBattle;

  // ---- 头部统计联动（供 index.html 包装 refreshBalances 调用）----
  function sgSyncWallet() {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    if (userCards) set('sgStatCards', userCards.length);
    if (sgAiStats) {
      // V2.1：总对战/胜场 = AI + PVP + 混战 + 关卡 四模式合计（链上 all_total/all_wins）
      const allT = sgAiStats.all_total != null ? sgAiStats.all_total : sgAiStats.total;
      const allW = sgAiStats.all_wins != null ? sgAiStats.all_wins : sgAiStats.wins;
      set('sgWin', allW != null ? allW : '—');
      set('sgBattle', allT != null ? allT : '—');
    }
    if (sgFragCache != null) set('sgFrag', sgFragCache);
  }
  window.__sgSyncWallet = sgSyncWallet;

  // ============================================================
  // 注册到大厅（关键：否则大厅不显示三国卡片）
  // ============================================================
  const SanguoGame = {
    meta: {
      id: 'sanguo',
      name: { zh: '逐雄三国2.0', en: 'Sanguo 2.0' },
      icon: '🀄',
      desc: { zh: '免费抽卡·买卡买碎片·9v9 三组对战', en: 'Free draw · buy cards · 9v9 group battles' },
      type: 'sanguo',
    },
  };
  if (!window.GAMES) window.GAMES = [];
  if (!window.GAME_REGISTRY) window.GAME_REGISTRY = {};
  window.GAMES.push(SanguoGame);
  window.GAME_REGISTRY['sanguo'] = SanguoGame;

  // 大厅切换语言时，若三国已打开则整页重渲染（含标题与页签文案）
  const _sgRerender = () => { if (document.getElementById('sgBody')) renderSanguo(); };
  window.__sgRerender = _sgRerender;
  window.addEventListener('hub-lang-change', _sgRerender);

})();
