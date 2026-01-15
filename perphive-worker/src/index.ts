/**
 * PERPHIVE API - Real-time Order Flow Intelligence
 *
 * Aggregates order books from Hyperliquid + OKX + Kraken
 * CryptoQuant on-chain data integration
 * Calculates cross-exchange signals
 * Broadcasts via WebSocket to dashboard
 */

export interface Env {
  ORDER_FLOW: DurableObjectNamespace;
  CACHE: KVNamespace;
  ENVIRONMENT: string;
  CRYPTOQUANT_API_KEY: string;
  POLYGON_API_KEY: string;
}

// Funding rates data
interface FundingData {
  btcFunding: number;      // Current funding rate (8h)
  ethFunding: number;
  btcAnnualized: number;   // Annualized %
  ethAnnualized: number;
  nextFundingTime: number;
  timestamp: number;
}

// Fetch OKX funding rates
async function fetchFundingRates(cache: KVNamespace): Promise<FundingData | null> {
  const cached = await cache.get('funding_data', 'json') as FundingData | null;
  if (cached && Date.now() - cached.timestamp < 60000) { // 1 min cache
    return cached;
  }

  try {
    const [btcResp, ethResp] = await Promise.all([
      fetch('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP'),
      fetch('https://www.okx.com/api/v5/public/funding-rate?instId=ETH-USDT-SWAP')
    ]);

    const btcData = await btcResp.json() as any;
    const ethData = await ethResp.json() as any;

    if (btcData.data?.[0] && ethData.data?.[0]) {
      const btcRate = parseFloat(btcData.data[0].fundingRate);
      const ethRate = parseFloat(ethData.data[0].fundingRate);

      const funding: FundingData = {
        btcFunding: btcRate,
        ethFunding: ethRate,
        btcAnnualized: btcRate * 3 * 365 * 100, // 3 funding periods per day * 365 days * 100 for %
        ethAnnualized: ethRate * 3 * 365 * 100,
        nextFundingTime: parseInt(btcData.data[0].nextFundingTime),
        timestamp: Date.now()
      };

      await cache.put('funding_data', JSON.stringify(funding), { expirationTtl: 300 });
      return funding;
    }
    return cached;
  } catch (e) {
    console.error('Funding fetch error:', e);
    return cached;
  }
}

// Market data (SPY, QQQ, DXY)
interface MarketData {
  spy: { price: number; change: number; changePct: number };
  qqq: { price: number; change: number; changePct: number };
  timestamp: number;
}

// Fetch SPY/QQQ from Polygon.io
async function fetchMarketData(apiKey: string, cache: KVNamespace): Promise<MarketData | null> {
  const cached = await cache.get('market_data', 'json') as MarketData | null;
  if (cached && Date.now() - cached.timestamp < 60000) { // 1 min cache
    return cached;
  }

  try {
    const [spyResp, qqqResp] = await Promise.all([
      fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/prev?apiKey=${apiKey}`),
      fetch(`https://api.polygon.io/v2/aggs/ticker/QQQ/prev?apiKey=${apiKey}`)
    ]);

    const spyData = await spyResp.json() as any;
    const qqqData = await qqqResp.json() as any;

    if (spyData.results?.[0] && qqqData.results?.[0]) {
      const spy = spyData.results[0];
      const qqq = qqqData.results[0];

      const market: MarketData = {
        spy: {
          price: spy.c,
          change: spy.c - spy.o,
          changePct: ((spy.c - spy.o) / spy.o) * 100
        },
        qqq: {
          price: qqq.c,
          change: qqq.c - qqq.o,
          changePct: ((qqq.c - qqq.o) / qqq.o) * 100
        },
        timestamp: Date.now()
      };

      await cache.put('market_data', JSON.stringify(market), { expirationTtl: 300 });
      return market;
    }
    return cached;
  } catch (e) {
    console.error('Market data fetch error:', e);
    return cached;
  }
}

// Long/Short Ratio data
interface LongShortData {
  btcRatio: number;    // >1 = more longs, <1 = more shorts
  ethRatio: number;
  btcSentiment: 'LONG_HEAVY' | 'SHORT_HEAVY' | 'BALANCED';
  ethSentiment: 'LONG_HEAVY' | 'SHORT_HEAVY' | 'BALANCED';
  timestamp: number;
}

// Fetch Long/Short ratio from OKX
async function fetchLongShortRatio(cache: KVNamespace): Promise<LongShortData | null> {
  const cached = await cache.get('ls_ratio', 'json') as LongShortData | null;
  if (cached && Date.now() - cached.timestamp < 60000) { // 1 min cache
    return cached;
  }

  try {
    const [btcResp, ethResp] = await Promise.all([
      fetch('https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=5m'),
      fetch('https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=ETH&period=5m')
    ]);

    const btcData = await btcResp.json() as any;
    const ethData = await ethResp.json() as any;

    const btcRatio = parseFloat(btcData.data?.[0]?.[1] || '1');
    const ethRatio = parseFloat(ethData.data?.[0]?.[1] || '1');

    // Sentiment thresholds: >1.3 = long heavy, <0.7 = short heavy
    const getSentiment = (ratio: number): 'LONG_HEAVY' | 'SHORT_HEAVY' | 'BALANCED' => {
      if (ratio > 1.3) return 'LONG_HEAVY';
      if (ratio < 0.7) return 'SHORT_HEAVY';
      return 'BALANCED';
    };

    const lsData: LongShortData = {
      btcRatio,
      ethRatio,
      btcSentiment: getSentiment(btcRatio),
      ethSentiment: getSentiment(ethRatio),
      timestamp: Date.now()
    };

    await cache.put('ls_ratio', JSON.stringify(lsData), { expirationTtl: 300 });
    return lsData;
  } catch (e) {
    console.error('L/S ratio fetch error:', e);
    return cached;
  }
}

// Open Interest data
interface OpenInterestData {
  btcOI: number;           // Total OI in USD
  ethOI: number;
  btcOIHyperliquid: number; // Hyperliquid OI in coins
  ethOIHyperliquid: number;
  btcOIOkx: number;        // OKX OI in USD
  ethOIOkx: number;
  timestamp: number;
}

// Fetch Open Interest from OKX and Hyperliquid
async function fetchOpenInterest(cache: KVNamespace): Promise<OpenInterestData | null> {
  const cached = await cache.get('oi_data', 'json') as OpenInterestData | null;
  if (cached && Date.now() - cached.timestamp < 60000) { // 1 min cache
    return cached;
  }

  try {
    const [okxBtc, okxEth, hlData] = await Promise.all([
      fetch('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP'),
      fetch('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=ETH-USDT-SWAP'),
      fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' })
      })
    ]);

    const okxBtcData = await okxBtc.json() as any;
    const okxEthData = await okxEth.json() as any;
    const hlDataJson = await hlData.json() as any;

    // OKX OI in USD
    const btcOIOkx = parseFloat(okxBtcData.data?.[0]?.oiUsd || '0');
    const ethOIOkx = parseFloat(okxEthData.data?.[0]?.oiUsd || '0');

    // Hyperliquid OI in coins (index 0 = BTC, index 1 = ETH)
    const btcOIHL = parseFloat(hlDataJson[1]?.[0]?.openInterest || '0');
    const ethOIHL = parseFloat(hlDataJson[1]?.[1]?.openInterest || '0');
    const btcPrice = parseFloat(hlDataJson[1]?.[0]?.markPx || '96000');
    const ethPrice = parseFloat(hlDataJson[1]?.[1]?.markPx || '3300');

    // Convert HL to USD
    const btcOIHLUsd = btcOIHL * btcPrice;
    const ethOIHLUsd = ethOIHL * ethPrice;

    const oi: OpenInterestData = {
      btcOI: btcOIOkx + btcOIHLUsd,
      ethOI: ethOIOkx + ethOIHLUsd,
      btcOIHyperliquid: btcOIHL,
      ethOIHyperliquid: ethOIHL,
      btcOIOkx: btcOIOkx,
      ethOIOkx: ethOIOkx,
      timestamp: Date.now()
    };

    await cache.put('oi_data', JSON.stringify(oi), { expirationTtl: 300 });
    return oi;
  } catch (e) {
    console.error('OI fetch error:', e);
    return cached;
  }
}

// Precious metals data
interface MetalsData {
  gold: number;
  silver: number;
  goldChange: number;
  silverChange: number;
  goldChangePct: number;
  silverChangePct: number;
  timestamp: number;
}

// Fetch gold/silver prices from goldprice.org
async function fetchMetalsData(cache: KVNamespace): Promise<MetalsData | null> {
  // Check cache (1 minute cache for metals)
  const cached = await cache.get('metals_data', 'json') as MetalsData | null;
  if (cached && Date.now() - cached.timestamp < 60000) {
    return cached;
  }

  try {
    const resp = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
    const data = await resp.json() as any;
    if (data.items && data.items[0]) {
      const item = data.items[0];
      const metals: MetalsData = {
        gold: item.xauPrice,
        silver: item.xagPrice,
        goldChange: item.chgXau,
        silverChange: item.chgXag,
        goldChangePct: item.pcXau,
        silverChangePct: item.pcXag,
        timestamp: Date.now()
      };
      await cache.put('metals_data', JSON.stringify(metals), { expirationTtl: 300 });
      return metals;
    }
    return cached;
  } catch (e) {
    console.error('Metals fetch error:', e);
    return cached;
  }
}

// CryptoQuant on-chain data
interface OnChainData {
  btcLeverageRatio: number;
  ethLeverageRatio: number;
  btcMinerPositionIndex: number;
  minerCompanies: MinerCompanyData[];
  lastUpdated: number;
}

// BTC Miner Company Data
interface MinerCompanyData {
  ticker: string;
  name: string;
  date: string;
  totalRewards: number;          // Daily BTC mined
  monthlyRewards: number;        // Accumulated monthly BTC
  dailyRewardsUSD: number;       // Daily USD value
  monthlyRewardsUSD: number;     // Monthly USD value
  activeAddresses: number;
}

// Map miner codes to display names and stock tickers
const MINER_INFO: Record<string, { ticker: string; name: string }> = {
  'mara': { ticker: 'MARA', name: 'Marathon Digital' },
  'riot': { ticker: 'RIOT', name: 'Riot Platforms' },
  'core': { ticker: 'CORZ', name: 'Core Scientific' },
  'hive': { ticker: 'HIVE', name: 'HIVE Digital' },
  'clsk': { ticker: 'CLSK', name: 'CleanSpark' },
  'bitf': { ticker: 'BITF', name: 'Bitfarms' },
  'cipher': { ticker: 'CIFR', name: 'Cipher Mining' },
  'wulf': { ticker: 'WULF', name: 'TeraWulf' },
  'iren': { ticker: 'IREN', name: 'Iris Energy' }
};

// Fetch CryptoQuant leverage ratio
async function fetchLeverageRatio(asset: 'btc' | 'eth', apiKey: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://api.cryptoquant.com/v1/${asset}/market-indicator/estimated-leverage-ratio?exchange=binance&window=day&limit=1`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    const data = await resp.json() as any;
    if (data.status?.code === 200 && data.result?.data?.[0]) {
      return data.result.data[0].estimated_leverage_ratio;
    }
    return null;
  } catch (e) {
    console.error('CryptoQuant leverage error:', e);
    return null;
  }
}

// Fetch CryptoQuant Miner Position Index (BTC only)
async function fetchMinerPositionIndex(apiKey: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://api.cryptoquant.com/v1/btc/flow-indicator/mpi?window=day&miner=all_miner&limit=1`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    const data = await resp.json() as any;
    if (data.status?.code === 200 && data.result?.data?.[0]) {
      return data.result.data[0].mpi;
    }
    return null;
  } catch (e) {
    console.error('CryptoQuant MPI error:', e);
    return null;
  }
}

// Fetch single miner company data from CryptoQuant
async function fetchMinerCompanyData(minerCode: string, apiKey: string): Promise<MinerCompanyData | null> {
  try {
    const resp = await fetch(
      `https://api.cryptoquant.com/v1/btc/miner-data/companies?miner=${minerCode}&window=day&limit=1`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    const data = await resp.json() as any;
    if (data.status?.code === 200 && data.result?.data?.[0]) {
      const d = data.result.data[0];
      const info = MINER_INFO[minerCode] || { ticker: minerCode.toUpperCase(), name: minerCode };
      return {
        ticker: info.ticker,
        name: info.name,
        date: d.date,
        totalRewards: d.total_rewards || 0,
        monthlyRewards: d.accumulated_monthly_rewards || 0,
        dailyRewardsUSD: d.total_daily_rewards_closing_usd || 0,
        monthlyRewardsUSD: d.accumulated_monthly_rewards_closing_usd || 0,
        activeAddresses: d.active_address_count || 0
      };
    }
    return null;
  } catch (e) {
    console.error(`CryptoQuant miner ${minerCode} error:`, e);
    return null;
  }
}

// Fetch all miner company data
async function fetchAllMinerData(apiKey: string): Promise<MinerCompanyData[]> {
  const minerCodes = Object.keys(MINER_INFO);
  const results = await Promise.all(
    minerCodes.map(code => fetchMinerCompanyData(code, apiKey))
  );
  // Filter nulls and sort by daily rewards (biggest miners first)
  return results
    .filter((m): m is MinerCompanyData => m !== null)
    .sort((a, b) => b.totalRewards - a.totalRewards);
}

// Fetch all CryptoQuant data (cached for 1 hour)
async function fetchOnChainData(apiKey: string, cache: KVNamespace): Promise<OnChainData> {
  // Check cache first
  const cached = await cache.get('cryptoquant_data', 'json') as OnChainData | null;
  if (cached && Date.now() - cached.lastUpdated < 3600000) { // 1 hour cache
    return cached;
  }

  // Fetch fresh data (all in parallel)
  const [btcLeverage, ethLeverage, mpi, minerData] = await Promise.all([
    fetchLeverageRatio('btc', apiKey),
    fetchLeverageRatio('eth', apiKey),
    fetchMinerPositionIndex(apiKey),
    fetchAllMinerData(apiKey)
  ]);

  const data: OnChainData = {
    btcLeverageRatio: btcLeverage || cached?.btcLeverageRatio || 0,
    ethLeverageRatio: ethLeverage || cached?.ethLeverageRatio || 0,
    btcMinerPositionIndex: mpi || cached?.btcMinerPositionIndex || 0,
    minerCompanies: minerData.length > 0 ? minerData : (cached?.minerCompanies || []),
    lastUpdated: Date.now()
  };

  // Cache for 1 hour
  await cache.put('cryptoquant_data', JSON.stringify(data), { expirationTtl: 3600 });

  return data;
}

// Types
interface OrderBook {
  bids: [number, number][];  // [price, size]
  asks: [number, number][];
  timestamp: number;
}

interface ExchangeData {
  price: number;
  imbalance: number;
  bidDepth: number;
  askDepth: number;
  timestamp: number;
}

interface WhaleConsensus {
  signal: 'LONG' | 'SHORT' | 'NEUTRAL';
  bidSize: number;      // Total whale bid size
  askSize: number;      // Total whale ask size
  bidCount: number;     // Number of whale bids
  askCount: number;     // Number of whale asks
  exchangesWithBids: number;  // How many exchanges have whale bids (0-3)
  exchangesWithAsks: number;  // How many exchanges have whale asks (0-3)
  strength: number;     // 0-100 consensus strength
}

interface Signal {
  asset: string;
  action: 'LONG' | 'SHORT' | 'WAIT';
  confidence: number;
  hyperliquid: ExchangeData;
  okx: ExchangeData;
  kraken: ExchangeData;
  crossExchangeSpread: number;  // bps
  combinedImbalance: number;
  imbalance15m: number;  // 15-minute average imbalance
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';  // sustained trend
  whaleOrders: WhaleOrder[];
  whaleConsensus: WhaleConsensus;
  supportLevels: SupportLevel[];
  resistanceLevels: SupportLevel[];
  timestamp: number;
}

interface WhaleOrder {
  exchange: string;
  side: 'BID' | 'ASK';
  price: number;
  size: number;
}

interface SupportLevel {
  price: number;
  strength: number;  // 0-100
  type: 'wall' | 'round' | 'cluster';
  totalSize: number;
  exchangeCount: number;  // 1, 2, or 3 exchanges
  isRoundNumber: boolean;
}

// Hyperliquid API
async function fetchHyperliquidOrderBook(coin: string): Promise<OrderBook | null> {
  try {
    const resp = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'l2Book', coin })
    });

    const data = await resp.json() as any;
    const levels = data.levels || [[], []];

    return {
      bids: levels[0].slice(0, 20).map((b: any) => [parseFloat(b.px), parseFloat(b.sz)]),
      asks: levels[1].slice(0, 20).map((a: any) => [parseFloat(a.px), parseFloat(a.sz)]),
      timestamp: Date.now()
    };
  } catch (e) {
    console.error('Hyperliquid error:', e);
    return null;
  }
}

// OKX API
async function fetchOKXOrderBook(symbol: string): Promise<OrderBook | null> {
  try {
    const resp = await fetch(`https://www.okx.com/api/v5/market/books?instId=${symbol}&sz=20`);
    const data = await resp.json() as any;

    if (data.data && data.data[0]) {
      const book = data.data[0];
      return {
        bids: book.bids.slice(0, 20).map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: book.asks.slice(0, 20).map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
        timestamp: parseInt(book.ts)
      };
    }
    return null;
  } catch (e) {
    console.error('OKX error:', e);
    return null;
  }
}

// Kraken Spot API (more reliable than futures)
async function fetchKrakenOrderBook(pair: string): Promise<OrderBook | null> {
  try {
    const resp = await fetch(`https://api.kraken.com/0/public/Depth?pair=${pair}&count=20`);
    const data = await resp.json() as any;

    if (data.result) {
      // Kraken uses weird pair names internally
      const bookKey = Object.keys(data.result)[0];
      const book = data.result[bookKey];
      return {
        // Kraken format: [price, volume, timestamp]
        bids: book.bids.slice(0, 20).map((b: [string, string, number]) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: book.asks.slice(0, 20).map((a: [string, string, number]) => [parseFloat(a[0]), parseFloat(a[1])]),
        timestamp: Date.now()
      };
    }
    return null;
  } catch (e) {
    console.error('Kraken error:', e);
    return null;
  }
}

// Calculate imbalance and depth
function analyzeOrderBook(book: OrderBook, whaleThreshold: number): {
  imbalance: number;
  bidDepth: number;
  askDepth: number;
  midPrice: number;
  whales: WhaleOrder[];
} {
  const bidDepth = book.bids.slice(0, 10).reduce((sum, [_, size]) => sum + size, 0);
  const askDepth = book.asks.slice(0, 10).reduce((sum, [_, size]) => sum + size, 0);
  const imbalance = (bidDepth - askDepth) / (bidDepth + askDepth);

  const midPrice = book.bids.length && book.asks.length
    ? (book.bids[0][0] + book.asks[0][0]) / 2
    : 0;

  const whales: WhaleOrder[] = [];

  for (const [price, size] of book.bids.slice(0, 20)) {
    if (size >= whaleThreshold) {
      whales.push({ exchange: '', side: 'BID', price, size });
    }
  }

  for (const [price, size] of book.asks.slice(0, 20)) {
    if (size >= whaleThreshold) {
      whales.push({ exchange: '', side: 'ASK', price, size });
    }
  }

  return { imbalance, bidDepth, askDepth, midPrice, whales };
}

// Detect support/resistance levels from order books (3 exchanges)
function detectLevels(
  hlBook: OrderBook | null,
  okxBook: OrderBook | null,
  krakenBook: OrderBook | null,
  side: 'bids' | 'asks',
  asset: string
): SupportLevel[] {
  // Track size and which exchanges have orders at each level
  const levels: Map<number, { size: number; hasHL: boolean; hasOKX: boolean; hasKraken: boolean }> = new Map();
  const midPrice = hlBook?.bids[0]?.[0] || okxBook?.bids[0]?.[0] || krakenBook?.bids[0]?.[0] || 0;

  // Round to appropriate level based on asset
  const roundTo = asset === 'BTC' ? 100 : 10;  // $100 for BTC, $10 for ETH

  // Process Hyperliquid orders
  if (hlBook) {
    const orders = side === 'bids' ? hlBook.bids : hlBook.asks;
    for (const [price, size] of orders) {
      const roundedPrice = Math.round(price / roundTo) * roundTo;
      const existing = levels.get(roundedPrice) || { size: 0, hasHL: false, hasOKX: false, hasKraken: false };
      existing.size += size;
      existing.hasHL = true;
      levels.set(roundedPrice, existing);
    }
  }

  // Process OKX orders
  if (okxBook) {
    const orders = side === 'bids' ? okxBook.bids : okxBook.asks;
    for (const [price, size] of orders) {
      const roundedPrice = Math.round(price / roundTo) * roundTo;
      const existing = levels.get(roundedPrice) || { size: 0, hasHL: false, hasOKX: false, hasKraken: false };
      existing.size += size;
      existing.hasOKX = true;
      levels.set(roundedPrice, existing);
    }
  }

  // Process Kraken orders
  if (krakenBook) {
    const orders = side === 'bids' ? krakenBook.bids : krakenBook.asks;
    for (const [price, size] of orders) {
      const roundedPrice = Math.round(price / roundTo) * roundTo;
      const existing = levels.get(roundedPrice) || { size: 0, hasHL: false, hasOKX: false, hasKraken: false };
      existing.size += size;
      existing.hasKraken = true;
      levels.set(roundedPrice, existing);
    }
  }

  // Convert to array and score
  const result: SupportLevel[] = [];

  for (const [price, data] of levels) {
    // Skip if too far from current price (>5%)
    if (midPrice > 0 && Math.abs(price - midPrice) / midPrice > 0.05) continue;

    // Calculate strength based on size and clustering
    let strength = 0;

    // Size-based strength (normalized)
    const sizeThreshold = asset === 'BTC' ? 10 : 100;
    strength += Math.min(50, (data.size / sizeThreshold) * 50);

    // Exchange count bonus (orders on multiple exchanges = stronger level)
    const exchangeCount = (data.hasHL ? 1 : 0) + (data.hasOKX ? 1 : 0) + (data.hasKraken ? 1 : 0);
    if (exchangeCount >= 2) strength += 15;
    if (exchangeCount === 3) strength += 15;  // Extra bonus for all 3

    // Round number bonus
    const isRoundNumber = asset === 'BTC'
      ? price % 1000 === 0  // $95000, $96000, etc.
      : price % 100 === 0;  // $3300, $3400, etc.
    if (isRoundNumber) strength += 30;

    // Determine type
    let type: 'wall' | 'round' | 'cluster' = 'cluster';
    if (data.size >= sizeThreshold * 2) type = 'wall';
    else if (isRoundNumber) type = 'round';
    else if (exchangeCount >= 2) type = 'cluster';

    result.push({
      price,
      strength: Math.min(100, Math.round(strength)),
      type,
      totalSize: Math.round(data.size * 100) / 100,
      exchangeCount,
      isRoundNumber
    });
  }

  // Sort by strength and return top 5
  return result
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5);
}

// Calculate whale consensus across exchanges
function calculateWhaleConsensus(whaleOrders: WhaleOrder[]): WhaleConsensus {
  // Separate bids and asks
  const bids = whaleOrders.filter(w => w.side === 'BID');
  const asks = whaleOrders.filter(w => w.side === 'ASK');

  // Calculate totals
  const bidSize = bids.reduce((sum, w) => sum + w.size, 0);
  const askSize = asks.reduce((sum, w) => sum + w.size, 0);

  // Count unique exchanges with bids/asks
  const exchangesWithBids = new Set(bids.map(w => w.exchange)).size;
  const exchangesWithAsks = new Set(asks.map(w => w.exchange)).size;

  // Calculate signal
  let signal: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let strength = 0;

  const totalSize = bidSize + askSize;
  if (totalSize > 0) {
    const bidRatio = bidSize / totalSize;

    // Determine signal based on size imbalance AND exchange agreement
    if (bidRatio > 0.6 && exchangesWithBids >= 2) {
      signal = 'LONG';
      // Strength: higher if more exchanges agree and bigger size imbalance
      strength = Math.min(100, Math.round(
        (bidRatio - 0.5) * 100 +  // Size imbalance contribution (0-50)
        exchangesWithBids * 15 +   // Exchange agreement (15-45)
        (bids.length >= 3 ? 10 : 0) // Multiple whale orders bonus
      ));
    } else if (bidRatio < 0.4 && exchangesWithAsks >= 2) {
      signal = 'SHORT';
      strength = Math.min(100, Math.round(
        (0.5 - bidRatio) * 100 +
        exchangesWithAsks * 15 +
        (asks.length >= 3 ? 10 : 0)
      ));
    }

    // Extra strength if ALL 3 exchanges agree
    if (signal === 'LONG' && exchangesWithBids === 3) strength = Math.min(100, strength + 15);
    if (signal === 'SHORT' && exchangesWithAsks === 3) strength = Math.min(100, strength + 15);
  }

  return {
    signal,
    bidSize: Math.round(bidSize * 100) / 100,
    askSize: Math.round(askSize * 100) / 100,
    bidCount: bids.length,
    askCount: asks.length,
    exchangesWithBids,
    exchangesWithAsks,
    strength
  };
}

// Generate signal from aggregated data (3 exchanges)
function generateSignal(
  asset: string,
  hlData: ExchangeData | null,
  okxData: ExchangeData | null,
  krakenData: ExchangeData | null,
  whaleOrders: WhaleOrder[],
  supportLevels: SupportLevel[],
  resistanceLevels: SupportLevel[],
  imbalance15m: number = 0,
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL'
): Signal {
  const now = Date.now();

  // Default empty data
  const emptyData: ExchangeData = { price: 0, imbalance: 0, bidDepth: 0, askDepth: 0, timestamp: now };
  const hl = hlData || emptyData;
  const okx = okxData || emptyData;
  const kraken = krakenData || emptyData;

  // Cross-exchange spread in bps (use HL vs OKX as primary)
  let spread = 0;
  if (hl.price > 0 && okx.price > 0) {
    spread = ((hl.price - okx.price) / okx.price) * 10000;
  }

  // Combined imbalance (average of all available exchanges) - instant
  const validExchanges = [hlData, okxData, krakenData].filter(e => e !== null) as ExchangeData[];
  const combinedImbalance = validExchanges.length > 0
    ? validExchanges.reduce((sum, e) => sum + e.imbalance, 0) / validExchanges.length
    : 0;

  // Signal logic - USE 15M TREND, not instant imbalance
  let action: 'LONG' | 'SHORT' | 'WAIT' = 'WAIT';
  let confidence = Math.abs(imbalance15m) * 100;

  // Only signal when 15m trend is clear (>10% sustained imbalance)
  if (trend === 'BULLISH' && imbalance15m > 0.10) {
    action = 'LONG';
    confidence = Math.min(95, 50 + imbalance15m * 150);
  } else if (trend === 'BEARISH' && imbalance15m < -0.10) {
    action = 'SHORT';
    confidence = Math.min(95, 50 + Math.abs(imbalance15m) * 150);
  }

  // Boost confidence if current instant agrees with trend
  if (action !== 'WAIT') {
    if ((action === 'LONG' && combinedImbalance > 0.1) ||
        (action === 'SHORT' && combinedImbalance < -0.1)) {
      confidence = Math.min(95, confidence + 10);
    }
    // Count how many exchanges agree with trend
    let agreeing = 0;
    if (hlData && ((action === 'LONG' && hl.imbalance > 0) || (action === 'SHORT' && hl.imbalance < 0))) agreeing++;
    if (okxData && ((action === 'LONG' && okx.imbalance > 0) || (action === 'SHORT' && okx.imbalance < 0))) agreeing++;
    if (krakenData && ((action === 'LONG' && kraken.imbalance > 0) || (action === 'SHORT' && kraken.imbalance < 0))) agreeing++;

    // Bonus for exchange agreement
    if (agreeing >= 2) confidence = Math.min(95, confidence + 10);
    if (agreeing === 3) confidence = Math.min(95, confidence + 5);  // Extra for all 3
  }

  // Calculate whale consensus
  const whaleConsensus = calculateWhaleConsensus(whaleOrders);

  return {
    asset,
    action,
    confidence: Math.round(confidence),
    hyperliquid: hl,
    okx: okx,
    kraken: kraken,
    crossExchangeSpread: Math.round(spread * 10) / 10,
    combinedImbalance: Math.round(combinedImbalance * 1000) / 1000,
    imbalance15m: Math.round(imbalance15m * 1000) / 1000,
    trend,
    whaleOrders,
    whaleConsensus,
    supportLevels,
    resistanceLevels,
    timestamp: now
  };
}

// Fetch and aggregate all data (3 exchanges - REST fallback)
async function fetchAllData(): Promise<{ btc: Signal; eth: Signal }> {
  // Fetch all order books in parallel from 3 exchanges
  const [hlBtc, hlEth, okxBtc, okxEth, krakenBtc, krakenEth] = await Promise.all([
    fetchHyperliquidOrderBook('BTC'),
    fetchHyperliquidOrderBook('ETH'),
    fetchOKXOrderBook('BTC-USDT-SWAP'),
    fetchOKXOrderBook('ETH-USDT-SWAP'),
    fetchKrakenOrderBook('XBTUSD'),
    fetchKrakenOrderBook('ETHUSD')
  ]);

  // Analyze each
  const hlBtcAnalysis = hlBtc ? analyzeOrderBook(hlBtc, 5) : null;
  const hlEthAnalysis = hlEth ? analyzeOrderBook(hlEth, 50) : null;
  const okxBtcAnalysis = okxBtc ? analyzeOrderBook(okxBtc, 5) : null;
  const okxEthAnalysis = okxEth ? analyzeOrderBook(okxEth, 50) : null;
  const krakenBtcAnalysis = krakenBtc ? analyzeOrderBook(krakenBtc, 5) : null;
  const krakenEthAnalysis = krakenEth ? analyzeOrderBook(krakenEth, 50) : null;

  // Build exchange data - Hyperliquid
  const hlBtcData: ExchangeData | null = hlBtcAnalysis ? {
    price: hlBtcAnalysis.midPrice,
    imbalance: hlBtcAnalysis.imbalance,
    bidDepth: hlBtcAnalysis.bidDepth,
    askDepth: hlBtcAnalysis.askDepth,
    timestamp: hlBtc!.timestamp
  } : null;

  const hlEthData: ExchangeData | null = hlEthAnalysis ? {
    price: hlEthAnalysis.midPrice,
    imbalance: hlEthAnalysis.imbalance,
    bidDepth: hlEthAnalysis.bidDepth,
    askDepth: hlEthAnalysis.askDepth,
    timestamp: hlEth!.timestamp
  } : null;

  // Build exchange data - OKX
  const okxBtcData: ExchangeData | null = okxBtcAnalysis ? {
    price: okxBtcAnalysis.midPrice,
    imbalance: okxBtcAnalysis.imbalance,
    bidDepth: okxBtcAnalysis.bidDepth,
    askDepth: okxBtcAnalysis.askDepth,
    timestamp: okxBtc!.timestamp
  } : null;

  const okxEthData: ExchangeData | null = okxEthAnalysis ? {
    price: okxEthAnalysis.midPrice,
    imbalance: okxEthAnalysis.imbalance,
    bidDepth: okxEthAnalysis.bidDepth,
    askDepth: okxEthAnalysis.askDepth,
    timestamp: okxEth!.timestamp
  } : null;

  // Build exchange data - Kraken
  const krakenBtcData: ExchangeData | null = krakenBtcAnalysis ? {
    price: krakenBtcAnalysis.midPrice,
    imbalance: krakenBtcAnalysis.imbalance,
    bidDepth: krakenBtcAnalysis.bidDepth,
    askDepth: krakenBtcAnalysis.askDepth,
    timestamp: krakenBtc!.timestamp
  } : null;

  const krakenEthData: ExchangeData | null = krakenEthAnalysis ? {
    price: krakenEthAnalysis.midPrice,
    imbalance: krakenEthAnalysis.imbalance,
    bidDepth: krakenEthAnalysis.bidDepth,
    askDepth: krakenEthAnalysis.askDepth,
    timestamp: krakenEth!.timestamp
  } : null;

  // Collect whale orders from all 3 exchanges
  const btcWhales: WhaleOrder[] = [];
  const ethWhales: WhaleOrder[] = [];

  if (hlBtcAnalysis) {
    hlBtcAnalysis.whales.forEach(w => { w.exchange = 'Hyperliquid'; btcWhales.push(w); });
  }
  if (okxBtcAnalysis) {
    okxBtcAnalysis.whales.forEach(w => { w.exchange = 'OKX'; btcWhales.push(w); });
  }
  if (krakenBtcAnalysis) {
    krakenBtcAnalysis.whales.forEach(w => { w.exchange = 'Kraken'; btcWhales.push(w); });
  }
  if (hlEthAnalysis) {
    hlEthAnalysis.whales.forEach(w => { w.exchange = 'Hyperliquid'; ethWhales.push(w); });
  }
  if (okxEthAnalysis) {
    okxEthAnalysis.whales.forEach(w => { w.exchange = 'OKX'; ethWhales.push(w); });
  }
  if (krakenEthAnalysis) {
    krakenEthAnalysis.whales.forEach(w => { w.exchange = 'Kraken'; ethWhales.push(w); });
  }

  // Detect support/resistance levels (all 3 exchanges)
  const btcSupport = detectLevels(hlBtc, okxBtc, krakenBtc, 'bids', 'BTC');
  const btcResistance = detectLevels(hlBtc, okxBtc, krakenBtc, 'asks', 'BTC');
  const ethSupport = detectLevels(hlEth, okxEth, krakenEth, 'bids', 'ETH');
  const ethResistance = detectLevels(hlEth, okxEth, krakenEth, 'asks', 'ETH');

  return {
    btc: generateSignal('BTC', hlBtcData, okxBtcData, krakenBtcData, btcWhales, btcSupport, btcResistance),
    eth: generateSignal('ETH', hlEthData, okxEthData, krakenEthData, ethWhales, ethSupport, ethResistance)
  };
}

// Imbalance history entry
interface ImbalanceEntry {
  timestamp: number;
  btcImbalance: number;
  ethImbalance: number;
}

// Calculate 15m average and trend from history
function calculateTrend(history: ImbalanceEntry[], asset: 'btc' | 'eth'): { avg: number; trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' } {
  if (history.length === 0) return { avg: 0, trend: 'NEUTRAL' };

  const now = Date.now();
  const fifteenMinAgo = now - 15 * 60 * 1000;

  // Filter to last 15 minutes
  const recent = history.filter(h => h.timestamp > fifteenMinAgo);
  if (recent.length === 0) return { avg: 0, trend: 'NEUTRAL' };

  // Calculate average
  const sum = recent.reduce((s, h) => s + (asset === 'btc' ? h.btcImbalance : h.ethImbalance), 0);
  const avg = sum / recent.length;

  // Determine trend - need sustained bias
  // Count how many readings are bullish vs bearish
  const bullishCount = recent.filter(h => (asset === 'btc' ? h.btcImbalance : h.ethImbalance) > 0.05).length;
  const bearishCount = recent.filter(h => (asset === 'btc' ? h.btcImbalance : h.ethImbalance) < -0.05).length;
  const totalCount = recent.length;

  let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

  // Need 60%+ readings in same direction for trend
  if (bullishCount / totalCount > 0.6 && avg > 0.05) {
    trend = 'BULLISH';
  } else if (bearishCount / totalCount > 0.6 && avg < -0.05) {
    trend = 'BEARISH';
  }

  return { avg, trend };
}

// Durable Object for WebSocket connections
export class OrderFlowDO implements DurableObject {
  state: DurableObjectState;
  sessions: Set<WebSocket>;
  lastData: { btc: Signal; eth: Signal } | null = null;
  imbalanceHistory: ImbalanceEntry[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sessions = new Set();

    // Start polling loop
    this.startPolling();
  }

  async startPolling() {
    // Poll every 2 seconds
    while (true) {
      try {
        this.lastData = await this.fetchWithTrend();
        this.broadcast(this.lastData);
      } catch (e) {
        console.error('Polling error:', e);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  async fetchWithTrend(): Promise<{ btc: Signal; eth: Signal }> {
    // Fetch raw order book data from all 3 exchanges
    const [hlBtc, hlEth, okxBtc, okxEth, krakenBtc, krakenEth] = await Promise.all([
      fetchHyperliquidOrderBook('BTC'),
      fetchHyperliquidOrderBook('ETH'),
      fetchOKXOrderBook('BTC-USDT-SWAP'),
      fetchOKXOrderBook('ETH-USDT-SWAP'),
      fetchKrakenOrderBook('XBTUSD'),   // Kraken BTC spot
      fetchKrakenOrderBook('ETHUSD')    // Kraken ETH spot
    ]);

    // Analyze each
    const hlBtcAnalysis = hlBtc ? analyzeOrderBook(hlBtc, 5) : null;
    const hlEthAnalysis = hlEth ? analyzeOrderBook(hlEth, 50) : null;
    const okxBtcAnalysis = okxBtc ? analyzeOrderBook(okxBtc, 5) : null;
    const okxEthAnalysis = okxEth ? analyzeOrderBook(okxEth, 50) : null;
    const krakenBtcAnalysis = krakenBtc ? analyzeOrderBook(krakenBtc, 5) : null;
    const krakenEthAnalysis = krakenEth ? analyzeOrderBook(krakenEth, 50) : null;

    // Calculate current imbalances (average of all 3 exchanges)
    const btcImbalances = [hlBtcAnalysis?.imbalance, okxBtcAnalysis?.imbalance, krakenBtcAnalysis?.imbalance].filter(i => i !== undefined) as number[];
    const ethImbalances = [hlEthAnalysis?.imbalance, okxEthAnalysis?.imbalance, krakenEthAnalysis?.imbalance].filter(i => i !== undefined) as number[];
    const btcImbalance = btcImbalances.length > 0 ? btcImbalances.reduce((a, b) => a + b, 0) / btcImbalances.length : 0;
    const ethImbalance = ethImbalances.length > 0 ? ethImbalances.reduce((a, b) => a + b, 0) / ethImbalances.length : 0;

    // Record to history
    const now = Date.now();
    this.imbalanceHistory.push({
      timestamp: now,
      btcImbalance,
      ethImbalance
    });

    // Trim history to last 20 minutes
    const twentyMinAgo = now - 20 * 60 * 1000;
    this.imbalanceHistory = this.imbalanceHistory.filter(h => h.timestamp > twentyMinAgo);

    // Calculate 15m trends
    const btcTrend = calculateTrend(this.imbalanceHistory, 'btc');
    const ethTrend = calculateTrend(this.imbalanceHistory, 'eth');

    // Build exchange data - Hyperliquid
    const hlBtcData: ExchangeData | null = hlBtcAnalysis ? {
      price: hlBtcAnalysis.midPrice,
      imbalance: hlBtcAnalysis.imbalance,
      bidDepth: hlBtcAnalysis.bidDepth,
      askDepth: hlBtcAnalysis.askDepth,
      timestamp: hlBtc!.timestamp
    } : null;

    const hlEthData: ExchangeData | null = hlEthAnalysis ? {
      price: hlEthAnalysis.midPrice,
      imbalance: hlEthAnalysis.imbalance,
      bidDepth: hlEthAnalysis.bidDepth,
      askDepth: hlEthAnalysis.askDepth,
      timestamp: hlEth!.timestamp
    } : null;

    // Build exchange data - OKX
    const okxBtcData: ExchangeData | null = okxBtcAnalysis ? {
      price: okxBtcAnalysis.midPrice,
      imbalance: okxBtcAnalysis.imbalance,
      bidDepth: okxBtcAnalysis.bidDepth,
      askDepth: okxBtcAnalysis.askDepth,
      timestamp: okxBtc!.timestamp
    } : null;

    const okxEthData: ExchangeData | null = okxEthAnalysis ? {
      price: okxEthAnalysis.midPrice,
      imbalance: okxEthAnalysis.imbalance,
      bidDepth: okxEthAnalysis.bidDepth,
      askDepth: okxEthAnalysis.askDepth,
      timestamp: okxEth!.timestamp
    } : null;

    // Build exchange data - Kraken
    const krakenBtcData: ExchangeData | null = krakenBtcAnalysis ? {
      price: krakenBtcAnalysis.midPrice,
      imbalance: krakenBtcAnalysis.imbalance,
      bidDepth: krakenBtcAnalysis.bidDepth,
      askDepth: krakenBtcAnalysis.askDepth,
      timestamp: krakenBtc!.timestamp
    } : null;

    const krakenEthData: ExchangeData | null = krakenEthAnalysis ? {
      price: krakenEthAnalysis.midPrice,
      imbalance: krakenEthAnalysis.imbalance,
      bidDepth: krakenEthAnalysis.bidDepth,
      askDepth: krakenEthAnalysis.askDepth,
      timestamp: krakenEth!.timestamp
    } : null;

    // Collect whale orders from all 3 exchanges
    const btcWhales: WhaleOrder[] = [];
    const ethWhales: WhaleOrder[] = [];

    if (hlBtcAnalysis) {
      hlBtcAnalysis.whales.forEach(w => { w.exchange = 'Hyperliquid'; btcWhales.push(w); });
    }
    if (okxBtcAnalysis) {
      okxBtcAnalysis.whales.forEach(w => { w.exchange = 'OKX'; btcWhales.push(w); });
    }
    if (krakenBtcAnalysis) {
      krakenBtcAnalysis.whales.forEach(w => { w.exchange = 'Kraken'; btcWhales.push(w); });
    }
    if (hlEthAnalysis) {
      hlEthAnalysis.whales.forEach(w => { w.exchange = 'Hyperliquid'; ethWhales.push(w); });
    }
    if (okxEthAnalysis) {
      okxEthAnalysis.whales.forEach(w => { w.exchange = 'OKX'; ethWhales.push(w); });
    }
    if (krakenEthAnalysis) {
      krakenEthAnalysis.whales.forEach(w => { w.exchange = 'Kraken'; ethWhales.push(w); });
    }

    // Detect support/resistance levels (all 3 exchanges)
    const btcSupport = detectLevels(hlBtc, okxBtc, krakenBtc, 'bids', 'BTC');
    const btcResistance = detectLevels(hlBtc, okxBtc, krakenBtc, 'asks', 'BTC');
    const ethSupport = detectLevels(hlEth, okxEth, krakenEth, 'bids', 'ETH');
    const ethResistance = detectLevels(hlEth, okxEth, krakenEth, 'asks', 'ETH');

    return {
      btc: generateSignal('BTC', hlBtcData, okxBtcData, krakenBtcData, btcWhales, btcSupport, btcResistance, btcTrend.avg, btcTrend.trend),
      eth: generateSignal('ETH', hlEthData, okxEthData, krakenEthData, ethWhales, ethSupport, ethResistance, ethTrend.avg, ethTrend.trend)
    };
  }

  broadcast(data: { btc: Signal; eth: Signal }) {
    const message = JSON.stringify(data);
    for (const ws of this.sessions) {
      try {
        ws.send(message);
      } catch (e) {
        this.sessions.delete(ws);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server);
      this.sessions.add(server);

      // Send current data immediately
      if (this.lastData) {
        server.send(JSON.stringify(this.lastData));
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    // REST endpoint - return current data
    if (this.lastData) {
      return new Response(JSON.stringify(this.lastData), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Fetch fresh data
    const data = await fetchAllData();
    this.lastData = data;

    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Handle ping/pong or client messages
    if (message === 'ping') {
      ws.send('pong');
    }
  }

  webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }
}

// Main worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // On-chain data endpoint (CryptoQuant)
    if (url.pathname === '/api/onchain') {
      try {
        const onChainData = await fetchOnChainData(env.CRYPTOQUANT_API_KEY, env.CACHE);
        return new Response(JSON.stringify({
          status: 'ok',
          data: onChainData,
          interpretation: {
            btcLeverage: onChainData.btcLeverageRatio > 0.2 ? 'HIGH' : onChainData.btcLeverageRatio > 0.15 ? 'MEDIUM' : 'LOW',
            ethLeverage: onChainData.ethLeverageRatio > 0.5 ? 'HIGH' : onChainData.ethLeverageRatio > 0.3 ? 'MEDIUM' : 'LOW',
            minerSentiment: onChainData.btcMinerPositionIndex < -0.1 ? 'ACCUMULATING' : onChainData.btcMinerPositionIndex > 0.1 ? 'DISTRIBUTING' : 'NEUTRAL'
          }
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ status: 'error', message: 'Failed to fetch on-chain data' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // All data endpoints go through Durable Object (for trend tracking)
    if (url.pathname === '/api/signals' || url.pathname === '/ws' || url.pathname === '/api/data') {
      // Route to Durable Object
      const id = env.ORDER_FLOW.idFromName('global');
      const stub = env.ORDER_FLOW.get(id);

      // For /api/data, enrich with on-chain data, metals, funding, market, and OI
      if (url.pathname === '/api/data') {
        const [doResponse, onChainData, metalsData, fundingData, marketData, oiData, lsData] = await Promise.all([
          stub.fetch(request),
          fetchOnChainData(env.CRYPTOQUANT_API_KEY, env.CACHE).catch(() => null),
          fetchMetalsData(env.CACHE).catch(() => null),
          fetchFundingRates(env.CACHE).catch(() => null),
          fetchMarketData(env.POLYGON_API_KEY, env.CACHE).catch(() => null),
          fetchOpenInterest(env.CACHE).catch(() => null),
          fetchLongShortRatio(env.CACHE).catch(() => null)
        ]);

        const orderFlowData = await doResponse.json();

        return new Response(JSON.stringify({
          ...orderFlowData as object,
          onChain: onChainData ? {
            btcLeverageRatio: onChainData.btcLeverageRatio,
            ethLeverageRatio: onChainData.ethLeverageRatio,
            btcMinerPositionIndex: onChainData.btcMinerPositionIndex,
            minerSentiment: onChainData.btcMinerPositionIndex < -0.1 ? 'ACCUMULATING' : onChainData.btcMinerPositionIndex > 0.1 ? 'DISTRIBUTING' : 'NEUTRAL',
            minerCompanies: onChainData.minerCompanies || []
          } : null,
          metals: metalsData,
          funding: fundingData,
          market: marketData,
          openInterest: oiData,
          longShort: lsData
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      return stub.fetch(request);
    }

    // Root - API info
    return new Response(JSON.stringify({
      name: 'PERPHIVE API',
      version: '1.0.0',
      endpoints: {
        '/api/data': 'GET - Current order flow data (REST)',
        '/api/signals': 'GET - Current signals (REST) or WebSocket upgrade',
        '/ws': 'WebSocket - Real-time signal stream',
        '/health': 'GET - Health check'
      }
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
