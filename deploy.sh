#!/bin/bash
# 三国卡牌游戏合约部署脚本
# 使用前请确保:
#   1. paxid 已安装 (curl -sL https://raw.githubusercontent.com/paxi-web3/paxi/main/scripts/cli_install.sh | bash)
#   2. paxid keys add <your_key> 已创建或导入
#   3. 该账户有足够 PAXI 支付 gas
#   4. ✅ wasm 文件已通过 GitHub Actions 编译完成
#      （在 GitHub 仓库 → Actions → 选最新运行 → Artifacts 下载 zip 解压得到 .wasm）
#
# 用法:
#   chmod +x deploy.sh
#   ./deploy.sh <your_key_name> <path_to_wasm_file>
#
# 示例:
#   ./deploy.sh mykey ./three_kingdoms_card_game.wasm

set -e

# 依赖检查：jq 和 paxid 必须已安装
command -v jq >/dev/null 2>&1 || { echo "❌ 需要安装 jq（sudo apt install jq 或 brew install jq）"; exit 1; }
command -v paxid >/dev/null 2>&1 || { echo "❌ 需要安装 paxid（curl -sL https://raw.githubusercontent.com/paxi-web3/paxi/main/scripts/cli_install.sh | bash）"; exit 1; }

KEY_NAME=${1:?"Usage: ./deploy.sh <your_key_name> <path_to_wasm_file>"}
WASM_FILE=${2:?"Usage: ./deploy.sh <your_key_name> <path_to_wasm_file>"}

echo "============================================================"
echo "🐉 三国卡牌游戏合约部署"
echo "============================================================"
echo "使用密钥: $KEY_NAME"
echo "wasm 文件: $WASM_FILE"
echo ""

# ============================================================
# 步骤 1: 验证 wasm 文件
# ============================================================
echo "📦 步骤 1/4: 验证 wasm 文件..."
if [ ! -f "$WASM_FILE" ]; then
    echo "❌ 找不到 wasm 文件: $WASM_FILE"
    echo ""
    echo "📥 下载 wasm 步骤:"
    echo "   1. 把整个项目 push 到 GitHub"
    echo "   2. 进入 GitHub 仓库 → Actions 标签"
    echo "   3. 选最新一次 'Build CosmWasm Contract' 运行"
    echo "   4. 滚动到底部 Artifacts 区域"
    echo "   5. 点 'three-kingdoms-card-game-wasm' 下载 zip"
    echo "   6. 解压得到 three_kingdoms_card_game.wasm"
    echo "   7. 重新运行: ./deploy.sh $KEY_NAME ./three_kingdoms_card_game.wasm"
    exit 1
fi

WASM_SIZE=$(du -h "$WASM_FILE" | cut -f1)
echo "✅ wasm 文件验证通过 (大小: $WASM_SIZE)"

# ============================================================
# 步骤 2: 上传合约
# ============================================================
echo ""
echo "📤 步骤 2/4: 上传合约到 Paxi 链..."
UPLOAD_TX=$(paxid tx wasm store "$WASM_FILE" \
    --from "$KEY_NAME" \
    --gas auto \
    --gas-prices 0.05upaxi \
    --output json -y)

UPLOAD_TX_HASH=$(echo "$UPLOAD_TX" | jq -r '.txhash')
echo "上传交易哈希: $UPLOAD_TX_HASH"

# 等待交易确认
echo "⏳ 等待交易确认 (5秒)..."
sleep 5

# 查询 code_id
CODE_ID=$(curl -s "https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$UPLOAD_TX_HASH" \
    | jq -r '.tx_response.events[]
    | select(.type=="store_code")
    | .attributes[]
    | select(.key=="code_id")
    | .value')

if [ -z "$CODE_ID" ] || [ "$CODE_ID" = "null" ]; then
    echo "❌ 获取 code_id 失败，请手动查询:"
    echo "   curl -s \"https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$UPLOAD_TX_HASH\" | jq"
    exit 1
fi

echo "✅ 合约 code_id: $CODE_ID"

# ============================================================
# 步骤 3: 准备实例化参数
# ============================================================
echo ""
echo "📋 步骤 3/4: 准备实例化参数..."

# 已部署的 PRC-20 代币合约
PRC20_CONTRACT="paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms"

# 黑洞地址（销毁用）
BURN_ADDRESS="paxi1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"

# 11 个抽水地址
TAP_ADDRESSES='[
    "paxi1ngut7ymp4cmzu7drjrc2gv7rhtnq4p0u6cgl0g",
    "paxi1kg0fzzyldr5ldggd8hhvvmyhg9xx3j3uvkn8eg",
    "paxi1m62c5kqs0marmv54scz88nw4cx4k06yehd92fk",
    "paxi120u6khy4n4yk89vmmkynl8r6yruen6sd7k47pe",
    "paxi1c2z42224lqss50t5mme36nmu22r4fwef4rlwxu",
    "paxi19qfjacug75d4jkj5d7r8maachnezgwus0w8wup",
    "paxi164lc3lq67u9ghkuy0k2aa7xcun4al23putcmzn",
    "paxi1hm83zslpckq2xrnsgk3qswksll6esc76suf9sw",
    "paxi16smk5dq5qwyqvhkchrrwxhg9e2w7cvxpsx9f49",
    "paxi194kpjqhyz7re2g749lc2030cgeg4sql5ldvyem",
    "paxi1ykgjrygltdctjlthmhvzv09h3yey0acefmyfnm"
]'

# 无管理员模式：合约完全去中心化，部署后无任何管理员权限
DEPLOYER_ADDR=$(paxid keys show "$KEY_NAME" -a)
echo "部署者地址: $DEPLOYER_ADDR (仅用于部署，合约不保留任何管理员权限)"

# 首发卡牌模板（30 张三国人物，与前端 CARD_TEMPLATES 保持同步）
# 稀有度权重：legend=3 / epic=12 / rare=25 / common=40（与合约校验范围 2-5/10-15/20-30/35-45 一致）
INITIAL_TEMPLATES='[
  {"id":"card_001","name":"曹操","title":"魏武挥鞭","rarity":"legend","attack":105,"defense":95,"weight":3,"description":"魏武帝，乱世枭雄，挟天子以令诸侯。","image_url":"https://i.ibb.co/0pXyCqvs/image.png"},
  {"id":"card_002","name":"诸葛亮","title":"卧龙出山","rarity":"legend","attack":110,"defense":90,"weight":3,"description":"蜀汉丞相，卧龙先生，智谋无双。","image_url":"https://i.ibb.co/vvKKdPCq/image.png"},
  {"id":"card_003","name":"关羽","title":"武圣降世","rarity":"legend","attack":115,"defense":85,"weight":3,"description":"武圣，忠义无双，青龙偃月刀威震华夏。","image_url":"https://i.ibb.co/6743V8cB/image.png"},
  {"id":"card_004","name":"赵云","title":"常山龙胆","rarity":"legend","attack":100,"defense":100,"weight":3,"description":"常山赵子龙，一身是胆，七进七出。","image_url":"https://i.ibb.co/z98s8dS/image.png"},
  {"id":"card_005","name":"吕布","title":"飞将无双","rarity":"legend","attack":120,"defense":80,"weight":3,"description":"人中吕布，马中赤兔，飞将无双。","image_url":"https://i.ibb.co/S7Qjr3Hk/image.png"},
  {"id":"card_006","name":"司马懿","title":"冢虎沉谋","rarity":"legend","attack":95,"defense":110,"weight":3,"description":"冢虎，魏国权谋大师，老谋深算。","image_url":"https://i.ibb.co/S7RB8T90/image.png"},
  {"id":"card_007","name":"张飞","title":"当阳怒吼","rarity":"epic","attack":95,"defense":75,"weight":12,"description":"当阳桥头一声吼，喝退百万曹军。","image_url":"https://i.ibb.co/xSX7Bv0q/image.png"},
  {"id":"card_008","name":"马超","title":"锦马超","rarity":"epic","attack":90,"defense":80,"weight":12,"description":"西凉锦马超，勇冠三军。","image_url":"https://i.ibb.co/jkFY9h1Z/image.png"},
  {"id":"card_009","name":"黄忠","title":"百步穿杨","rarity":"epic","attack":85,"defense":85,"weight":12,"description":"老当益壮，百步穿杨。","image_url":"https://i.ibb.co/70bYyjF/image.png"},
  {"id":"card_010","name":"姜维","title":"麒麟之志","rarity":"epic","attack":88,"defense":82,"weight":12,"description":"蜀汉栋梁，继诸葛亮遗志，九伐中原。","image_url":"https://i.ibb.co/k2HxGQ25/image.png"},
  {"id":"card_011","name":"周瑜","title":"赤壁东风","rarity":"epic","attack":80,"defense":90,"weight":12,"description":"江东大都督，赤壁之战火烧曹军。","image_url":"https://i.ibb.co/99p7TBpH/image.png"},
  {"id":"card_012","name":"陆逊","title":"火烧连营","rarity":"epic","attack":82,"defense":88,"weight":12,"description":"吴国儒将，夷陵之战火烧连营。","image_url":"https://i.ibb.co/BKc8bJgc/image.png"},
  {"id":"card_013","name":"夏侯惇","title":"拔矢啖睛","rarity":"epic","attack":92,"defense":78,"weight":12,"description":"魏国猛将，拔矢啖睛，刚烈无比。","image_url":"https://i.ibb.co/Pz35X0Hc/image.png"},
  {"id":"card_014","name":"张辽","title":"威震逍遥","rarity":"epic","attack":88,"defense":82,"weight":12,"description":"威震逍遥津，八百破十万。","image_url":"https://i.ibb.co/4wwW0yRv/image.png"},
  {"id":"card_015","name":"魏延","title":"汉中镇守","rarity":"rare","attack":75,"defense":70,"weight":25,"description":"蜀汉后期大将，镇守汉中。","image_url":"https://i.ibb.co/99DDBg1y/image.png"},
  {"id":"card_016","name":"庞统","title":"凤雏落凤","rarity":"rare","attack":70,"defense":75,"weight":25,"description":"凤雏，与诸葛亮齐名，落凤坡陨落。","image_url":"https://i.ibb.co/mrpP4bYk/image.png"},
  {"id":"card_017","name":"法正","title":"睚眦必报","rarity":"rare","attack":68,"defense":72,"weight":25,"description":"蜀汉谋主，睚眦必报。","image_url":"https://i.ibb.co/jpMd1Bw/image.png"},
  {"id":"card_018","name":"甘宁","title":"锦帆贼","rarity":"rare","attack":80,"defense":60,"weight":25,"description":"吴国猛将，锦帆贼，百骑劫魏营。","image_url":"https://i.ibb.co/JVxVCnV/image.png"},
  {"id":"card_019","name":"太史慈","title":"北海救孔","rarity":"rare","attack":72,"defense":68,"weight":25,"description":"北海救孔融，神射无双。","image_url":"https://i.ibb.co/dhWs803/image.png"},
  {"id":"card_020","name":"孙策","title":"小霸王","rarity":"rare","attack":78,"defense":62,"weight":25,"description":"小霸王，江东基业奠基人。","image_url":"https://i.ibb.co/VWm6yT7W/image.png"},
  {"id":"card_021","name":"吕蒙","title":"吴下阿蒙","rarity":"rare","attack":65,"defense":75,"weight":25,"description":"吴下阿蒙，士别三日，刮目相看。","image_url":"https://i.ibb.co/WpvPY4y9/image.png"},
  {"id":"card_022","name":"邓艾","title":"阴平奇兵","rarity":"rare","attack":70,"defense":70,"weight":25,"description":"魏国名将，阴平偷渡灭蜀。","image_url":"https://i.ibb.co/KxZZb9RF/image.png"},
  {"id":"card_023","name":"廖化","title":"蜀中先锋","rarity":"common","attack":50,"defense":45,"weight":40,"description":"蜀汉老将，从关羽到诸葛亮，见证蜀汉兴衰。","image_url":"https://i.ibb.co/W4wfdFWg/image.png"},
  {"id":"card_024","name":"简雍","title":"雍容辩士","rarity":"common","attack":40,"defense":50,"weight":40,"description":"蜀汉昭德将军，以辩才著称。","image_url":"https://i.ibb.co/vCLxJLyP/image.png"},
  {"id":"card_025","name":"孙乾","title":"雍容辩士","rarity":"common","attack":38,"defense":48,"weight":40,"description":"蜀汉秉忠将军，长于外交。","image_url":"https://i.ibb.co/PGMxkthb/image.png"},
  {"id":"card_026","name":"糜竺","title":"富商军师","rarity":"common","attack":42,"defense":42,"weight":40,"description":"蜀汉安汉将军，富商出身，资助刘备。","image_url":"https://i.ibb.co/Z6sBmsxK/image.png"},
  {"id":"card_027","name":"诸葛瑾","title":"敦厚长者","rarity":"common","attack":45,"defense":55,"weight":40,"description":"吴国大将军，诸葛亮之兄，敦厚长者。","image_url":"https://i.ibb.co/yF6JZxTC/image.png"},
  {"id":"card_028","name":"鲁肃","title":"单刀赴会","rarity":"common","attack":48,"defense":52,"weight":40,"description":"吴国横江将军，主张联刘抗曹。","image_url":"https://i.ibb.co/tPPt4J3c/image.png"},
  {"id":"card_029","name":"程昱","title":"兖州谋主","rarity":"common","attack":44,"defense":46,"weight":40,"description":"魏国谋士，兖州之谋主。","image_url":"https://i.ibb.co/fmGRNrc/image.png"},
  {"id":"card_030","name":"贾诩","title":"毒士乱武","rarity":"common","attack":46,"defense":44,"weight":40,"description":"毒士，三国第一谋士，乱武天下。","image_url":"https://i.ibb.co/pvjK82Yb/image.png"}
]'

# 构造实例化 JSON（含 initial_templates）
INSTANTIATE_MSG=$(cat <<EOF
{
    "token_contract": "$PRC20_CONTRACT",
    "burn_address": "$BURN_ADDRESS",
    "tap_addresses": $TAP_ADDRESSES,
    "initial_templates": $INITIAL_TEMPLATES
}
EOF
)

echo "实例化参数:"
echo "$INSTANTIATE_MSG" | jq .

# ============================================================
# 步骤 4: 实例化合约
# ============================================================
echo ""
echo "🚀 步骤 4/4: 实例化合约..."
INIT_TX=$(paxid tx wasm instantiate "$CODE_ID" "$INSTANTIATE_MSG" \
    --from "$KEY_NAME" \
    --label "Three Kingdoms Card Game" \
    --no-admin \
    --gas auto \
    --gas-prices 0.05upaxi \
    --output json -y)

INIT_TX_HASH=$(echo "$INIT_TX" | jq -r '.txhash')
echo "实例化交易哈希: $INIT_TX_HASH"

echo "⏳ 等待交易确认 (5秒)..."
sleep 5

# 查询合约地址
GAME_CONTRACT_ADDR=$(curl -s "https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$INIT_TX_HASH" \
    | jq -r '.tx_response.events[]
    | select(.type=="instantiate")
    | .attributes[]
    | select(.key=="_contract_address")
    | .value')

if [ -z "$GAME_CONTRACT_ADDR" ] || [ "$GAME_CONTRACT_ADDR" = "null" ]; then
    echo "❌ 获取合约地址失败，请手动查询:"
    echo "   curl -s \"https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$INIT_TX_HASH\" | jq"
    exit 1
fi

# ============================================================
# 完成
# ============================================================
echo ""
echo "============================================================"
echo "🎉 部署成功！"
echo "============================================================"
echo "📋 合约信息:"
echo "   code_id:           $CODE_ID"
echo "   游戏合约地址:      $GAME_CONTRACT_ADDR"
echo "   PRC-20 代币合约:   $PRC20_CONTRACT"
echo "   管理员:            无（完全去中心化）"
echo ""
echo "📝 下一步:"
echo "   1. 把游戏合约地址填入 index_real.html 顶部的 GAME_CONTRACT 常量"
echo "   2. 修改 GAME_CONTRACT 的值（替换空字符串）为:"
echo "      const GAME_CONTRACT = '$GAME_CONTRACT_ADDR';"
echo "   3. 在 PaxiHub 钱包内打开 index_real.html 测试"
echo ""
echo "🔗 查询合约配置:"
echo "   paxid query wasm contract-state smart $GAME_CONTRACT_ADDR '{\"config\":{}}'"
echo ""
