#!/bin/bash
# KASPA Solo Mining Block Monitor
# Polls 2miners API and alerts on new blocks

WALLET="kaspa:qyp6mntj6r99luus6lxv4svlpfwss4eccpca6fs4v7l9ltqcsvsu7hqfn34dl5l"
API_URL="https://solo-kas.2miners.com/api/accounts/${WALLET}"
POLL_INTERVAL=30
LAST_BLOCK=""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# Format hashrate
format_hashrate() {
    local hr=$1
    if [ -z "$hr" ] || [ "$hr" == "null" ]; then
        echo "0 H/s"
        return
    fi

    if (( hr >= 1000000000000 )); then
        echo "$(echo "scale=2; $hr / 1000000000000" | bc) TH/s"
    elif (( hr >= 1000000000 )); then
        echo "$(echo "scale=2; $hr / 1000000000" | bc) GH/s"
    elif (( hr >= 1000000 )); then
        echo "$(echo "scale=2; $hr / 1000000" | bc) MH/s"
    else
        echo "${hr} H/s"
    fi
}

# Format KAS (sompi to KAS)
format_kas() {
    local sompi=$1
    if [ -z "$sompi" ] || [ "$sompi" == "null" ]; then
        echo "0 KAS"
        return
    fi
    echo "$(echo "scale=4; $sompi / 100000000" | bc) KAS"
}

# Play sound (if available)
play_alert() {
    if command -v paplay &> /dev/null; then
        paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null &
    elif command -v aplay &> /dev/null; then
        aplay -q /usr/share/sounds/alsa/Front_Center.wav 2>/dev/null &
    fi
}

clear
echo -e "${GREEN}"
echo "  ██╗  ██╗ █████╗ ███████╗██████╗  █████╗ "
echo "  ██║ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔══██╗"
echo "  █████╔╝ ███████║███████╗██████╔╝███████║"
echo "  ██╔═██╗ ██╔══██║╚════██║██╔═══╝ ██╔══██║"
echo "  ██║  ██╗██║  ██║███████║██║     ██║  ██║"
echo "  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝"
echo -e "${NC}"
echo -e "${CYAN}  Solo Mining Monitor | 2miners${NC}"
echo -e "${YELLOW}  Wallet: ${NC}${WALLET:0:20}...${WALLET: -10}"
echo ""
echo -e "  Polling every ${POLL_INTERVAL}s | Press Ctrl+C to exit"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

while true; do
    # Fetch data
    DATA=$(curl -s "$API_URL" 2>/dev/null)

    if [ -z "$DATA" ] || [ "$DATA" == "null" ]; then
        echo -e "${RED}[$(date '+%H:%M:%S')] API Error - retrying...${NC}"
        sleep $POLL_INTERVAL
        continue
    fi

    # Parse data
    HASHRATE=$(echo "$DATA" | jq -r '.currentHashrate // 0')
    LUCK=$(echo "$DATA" | jq -r '.currentLuck // "0"')
    REWARD_24H=$(echo "$DATA" | jq -r '.["24hreward"] // 0')
    BLOCKS_24H=$(echo "$DATA" | jq -r '.["24hnumreward"] // 0')
    BALANCE=$(echo "$DATA" | jq -r '.stats.balance // 0')
    REWARDS_COUNT=$(echo "$DATA" | jq -r '.rewards | length // 0')

    # Get latest block
    LATEST_BLOCK=$(echo "$DATA" | jq -r '.rewards[0].blockheight // ""')
    LATEST_REWARD=$(echo "$DATA" | jq -r '.rewards[0].reward // 0')
    LATEST_IMMATURE=$(echo "$DATA" | jq -r '.rewards[0].immature // false')

    # Check for new block
    if [ -n "$LAST_BLOCK" ] && [ "$LATEST_BLOCK" != "$LAST_BLOCK" ] && [ -n "$LATEST_BLOCK" ]; then
        echo ""
        echo -e "${GREEN}${BOLD}"
        echo "  ╔═══════════════════════════════════════════════════════╗"
        echo "  ║                                                       ║"
        echo "  ║     ⛏️  NEW BLOCK FOUND! ⛏️                            ║"
        echo "  ║                                                       ║"
        echo "  ╠═══════════════════════════════════════════════════════╣"
        echo -e "  ║  Block:  #${LATEST_BLOCK}                              "
        echo -e "  ║  Reward: $(format_kas $LATEST_REWARD)                  "
        echo -e "  ║  Status: $([ "$LATEST_IMMATURE" == "true" ] && echo "IMMATURE" || echo "MATURE")                               "
        echo "  ║                                                       ║"
        echo "  ╚═══════════════════════════════════════════════════════╝"
        echo -e "${NC}"
        play_alert
    fi

    LAST_BLOCK=$LATEST_BLOCK

    # Status line
    HR_FMT=$(format_hashrate $HASHRATE)
    BAL_FMT=$(format_kas $BALANCE)

    # Luck color
    LUCK_NUM=$(echo "$LUCK" | cut -d'.' -f1)
    if [ "$LUCK_NUM" -le 100 ] 2>/dev/null; then
        LUCK_COLOR=$GREEN
    elif [ "$LUCK_NUM" -le 200 ] 2>/dev/null; then
        LUCK_COLOR=$YELLOW
    else
        LUCK_COLOR=$RED
    fi

    echo -e "[$(date '+%H:%M:%S')] ${CYAN}HR:${NC} ${GREEN}${HR_FMT}${NC} | ${CYAN}Luck:${NC} ${LUCK_COLOR}${LUCK}%${NC} | ${CYAN}24h Reward:${NC} $(format_kas $REWARD_24H) | ${CYAN}Balance:${NC} ${YELLOW}${BAL_FMT}${NC} | ${CYAN}Rewards:${NC} ${REWARDS_COUNT}"

    sleep $POLL_INTERVAL
done
