#!/bin/bash
# RAVENCOIN Mining Monitor
# Polls 2miners API and alerts on new payments/blocks

WALLET="RKPyKUJ8gGmRSDAt7ueNkmdAPF12vjuALT"
API_URL="https://rvn.2miners.com/api/accounts/${WALLET}"
POLL_INTERVAL=30
LAST_PAYMENT=""
LAST_BLOCK=""

# Colors
PURPLE='\033[0;35m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# Format hashrate
format_hashrate() {
    local hr=$1
    if [ -z "$hr" ] || [ "$hr" == "null" ] || [ "$hr" == "0" ]; then
        echo "0 H/s"
        return
    fi

    if (( hr >= 1000000000 )); then
        echo "$(echo "scale=2; $hr / 1000000000" | bc) GH/s"
    elif (( hr >= 1000000 )); then
        echo "$(echo "scale=2; $hr / 1000000" | bc) MH/s"
    elif (( hr >= 1000 )); then
        echo "$(echo "scale=2; $hr / 1000" | bc) KH/s"
    else
        echo "${hr} H/s"
    fi
}

# Format RVN (satoshis to RVN)
format_rvn() {
    local sats=$1
    if [ -z "$sats" ] || [ "$sats" == "null" ]; then
        echo "0 RVN"
        return
    fi
    echo "$(echo "scale=4; $sats / 100000000" | bc) RVN"
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
echo -e "${PURPLE}"
echo "  ██████╗  █████╗ ██╗   ██╗███████╗███╗   ██╗"
echo "  ██╔══██╗██╔══██╗██║   ██║██╔════╝████╗  ██║"
echo "  ██████╔╝███████║██║   ██║█████╗  ██╔██╗ ██║"
echo "  ██╔══██╗██╔══██║╚██╗ ██╔╝██╔══╝  ██║╚██╗██║"
echo "  ██║  ██║██║  ██║ ╚████╔╝ ███████╗██║ ╚████║"
echo "  ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═══╝"
echo -e "${NC}"
echo -e "${CYAN}  Mining Monitor | 2miners | Port 6060${NC}"
echo -e "${YELLOW}  Wallet: ${NC}${WALLET}"
echo ""
echo -e "  Polling every ${POLL_INTERVAL}s | Press Ctrl+C to exit"
echo -e "${PURPLE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
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
    AVG_HASHRATE=$(echo "$DATA" | jq -r '.hashrate // 0')
    LUCK=$(echo "$DATA" | jq -r '.currentLuck // "0"')
    BALANCE=$(echo "$DATA" | jq -r '.stats.balance // 0')
    PAID=$(echo "$DATA" | jq -r '.stats.paid // 0')
    BLOCKS_FOUND=$(echo "$DATA" | jq -r '.stats.blocksFound // 0')
    LAST_SHARE=$(echo "$DATA" | jq -r '.stats.lastShare // 0')
    WORKERS_ONLINE=$(echo "$DATA" | jq -r '.workersOnline // 0')
    WORKER_NAME=$(echo "$DATA" | jq -r '.config.ipWorkerName // "unknown"')

    # Get latest payment
    LATEST_PAYMENT_TX=$(echo "$DATA" | jq -r '.payments[0].tx // ""')
    LATEST_PAYMENT_AMT=$(echo "$DATA" | jq -r '.payments[0].amount // 0')

    # Get latest reward block
    LATEST_BLOCK=$(echo "$DATA" | jq -r '.rewards[0].blockheight // ""')

    # Check for new payment
    if [ -n "$LAST_PAYMENT" ] && [ "$LATEST_PAYMENT_TX" != "$LAST_PAYMENT" ] && [ -n "$LATEST_PAYMENT_TX" ]; then
        echo ""
        echo -e "${GREEN}${BOLD}"
        echo "  ╔═══════════════════════════════════════════════════════╗"
        echo "  ║                                                       ║"
        echo "  ║     💰  PAYMENT RECEIVED! 💰                          ║"
        echo "  ║                                                       ║"
        echo "  ╠═══════════════════════════════════════════════════════╣"
        echo -e "  ║  Amount: $(format_rvn $LATEST_PAYMENT_AMT)                           "
        echo -e "  ║  TX: ${LATEST_PAYMENT_TX:0:20}...                  "
        echo "  ║                                                       ║"
        echo "  ╚═══════════════════════════════════════════════════════╝"
        echo -e "${NC}"
        play_alert
    fi

    # Check for new block (solo)
    if [ "$BLOCKS_FOUND" != "0" ] && [ -n "$LAST_BLOCK" ] && [ "$LATEST_BLOCK" != "$LAST_BLOCK" ] && [ -n "$LATEST_BLOCK" ]; then
        REWARD=$(echo "$DATA" | jq -r '.rewards[0].reward // 0')
        echo ""
        echo -e "${PURPLE}${BOLD}"
        echo "  ╔═══════════════════════════════════════════════════════╗"
        echo "  ║                                                       ║"
        echo "  ║     ⛏️  NEW BLOCK REWARD! ⛏️                           ║"
        echo "  ║                                                       ║"
        echo "  ╠═══════════════════════════════════════════════════════╣"
        echo -e "  ║  Block:  #${LATEST_BLOCK}                              "
        echo -e "  ║  Reward: $(format_rvn $REWARD)                         "
        echo "  ║                                                       ║"
        echo "  ╚═══════════════════════════════════════════════════════╝"
        echo -e "${NC}"
        play_alert
    fi

    LAST_PAYMENT=$LATEST_PAYMENT_TX
    LAST_BLOCK=$LATEST_BLOCK

    # Status formatting
    HR_FMT=$(format_hashrate $HASHRATE)
    BAL_FMT=$(format_rvn $BALANCE)
    PAID_FMT=$(format_rvn $PAID)

    # Worker status
    if [ "$HASHRATE" == "0" ] || [ "$HASHRATE" == "null" ]; then
        STATUS="${RED}OFFLINE${NC}"
    else
        STATUS="${GREEN}ONLINE${NC}"
    fi

    # Luck color
    LUCK_NUM=$(echo "$LUCK" | cut -d'.' -f1)
    if [ "$LUCK_NUM" -le 100 ] 2>/dev/null; then
        LUCK_COLOR=$GREEN
    elif [ "$LUCK_NUM" -le 200 ] 2>/dev/null; then
        LUCK_COLOR=$YELLOW
    else
        LUCK_COLOR=$RED
    fi

    echo -e "[$(date '+%H:%M:%S')] ${CYAN}${WORKER_NAME}${NC} [${STATUS}] ${PURPLE}HR:${NC} ${HR_FMT} | ${PURPLE}Luck:${NC} ${LUCK_COLOR}${LUCK}%${NC} | ${PURPLE}Bal:${NC} ${YELLOW}${BAL_FMT}${NC} | ${PURPLE}Paid:${NC} ${GREEN}${PAID_FMT}${NC}"

    sleep $POLL_INTERVAL
done
