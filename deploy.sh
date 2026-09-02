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
    --fees 10000000upaxi \
    --output json -y)

UPLOAD_TX_HASH=$(echo "$UPLOAD_TX" | jq -r '.txhash')
echo "上传交易哈希: $UPLOAD_TX_HASH"

# 等待交易确认
echo "⏳ 等待交易确认 (5秒)..."
sleep 5

# 查询 code_id
CODE_ID=$(curl -s "GET" "https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$UPLOAD_TX_HASH" \
    | jq -r '.tx_response.events[]
    | select(.type=="store_code")
    | .attributes[]
    | select(.key=="code_id")
    | .value')

if [ -z "$CODE_ID" ] || [ "$CODE_ID" = "null" ]; then
    echo "❌ 获取 code_id 失败，请手动查询:"
    echo "   curl -s 'https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$UPLOAD_TX_HASH' | jq"
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

# 管理员地址（用你的密钥地址）
ADMIN_ADDR=$(paxid keys show "$KEY_NAME" -a)
echo "管理员地址: $ADMIN_ADDR"

# 构造实例化 JSON
INSTANTIATE_MSG=$(cat <<EOF
{
    "token_contract": "$PRC20_CONTRACT",
    "burn_address": "$BURN_ADDRESS",
    "tap_addresses": $TAP_ADDRESSES,
    "admin": "$ADMIN_ADDR"
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
    --fees 6000000upaxi \
    --output json -y)

INIT_TX_HASH=$(echo "$INIT_TX" | jq -r '.txhash')
echo "实例化交易哈希: $INIT_TX_HASH"

echo "⏳ 等待交易确认 (5秒)..."
sleep 5

# 查询合约地址
GAME_CONTRACT_ADDR=$(curl -s "GET" "https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$INIT_TX_HASH" \
    | jq -r '.tx_response.events[]
    | select(.type=="instantiate")
    | .attributes[]
    | select(.key=="_contract_address")
    | .value')

if [ -z "$GAME_CONTRACT_ADDR" ] || [ "$GAME_CONTRACT_ADDR" = "null" ]; then
    echo "❌ 获取合约地址失败，请手动查询:"
    echo "   curl -s 'https://mainnet-lcd.paxinet.io/cosmos/tx/v1beta1/txs/$INIT_TX_HASH' | jq"
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
echo "   管理员:            $ADMIN_ADDR"
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
