import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

type Token = { id: string; symbol: string; color: string };
type User = {
  id: string;
  name: string;
  preferences: string[];
  balances: Record<string, number>;
};

type PaymentStatus = 'requested' | 'accepted' | 'settled' | 'excluded';
type Payment = {
  id: string;
  sender: string;
  recipient: string;
  amount: number;
  token: string;
  status: PaymentStatus;
};

type SwapStatus = 'open' | 'matched' | 'settled' | 'excluded';
type Swap = {
  id: string;
  maker: string;
  sendToken: string;
  sendAmount: number;
  receiveToken: string;
  receiveAmount: number;
  status: SwapStatus;
  matchedId?: string;
};

type DvPStatus = 'open' | 'matched' | 'settled' | 'excluded';
type DvP = {
  id: string;
  maker: string;
  side: 'buy' | 'sell';
  assetId: number;
  paymentToken: string;
  price: number;
  counterparty?: string;
  status: DvPStatus;
  matchedId?: string;
  sellTerms?: Record<string, number>;
};

type TokenMap = Record<string, number>;

type SettlementReport = {
  id: string;
  startedAt: string;
  rounds: number;
  participants: string[];
  excludedUsers: string[];
  grossOutgoing: Record<string, number>;
  perTokenNet: Record<string, TokenMap>;
  netPositions: Record<string, number>;
  stakeCollected: Record<string, TokenMap>;
  lockCollected: Record<string, TokenMap>;
  poolBeforePayout: TokenMap;
  payouts: Record<string, TokenMap>;
  stakeRefunds: Record<string, TokenMap>;
  poolAfterPayout: TokenMap;
  transactionsSettled: {
    payments: number;
    swaps: number;
    dvps: number;
  };
  steps: string[];
};

const TOKENS: Token[] = [
  { id: 'TKA', symbol: 'TKA', color: '#4cc9f0' },
  { id: 'TKB', symbol: 'TKB', color: '#f77f00' },
  { id: 'TKC', symbol: 'TKC', color: '#2a9d8f' },
  { id: 'TKD', symbol: 'TKD', color: '#b5179e' },
];

const shuffleTokens = (tokens: string[]) => {
  const shuffled = [...tokens];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const DEFAULT_USERS: User[] = Array.from({ length: 5 }).map((_, i) => ({
  id: `U${i + 1}`,
  name: `User ${i + 1}`,
  preferences: shuffleTokens(['TKA', 'TKB', 'TKC', 'TKD']),
  balances: {
    TKA: 1000,
    TKB: 1000,
    TKC: 1000,
    TKD: 1000,
  },
}));

const roundAmount = (value: number) => Math.round(value * 100) / 100;
const sumTokens = (map: TokenMap) =>
  Object.values(map).reduce((acc, val) => acc + val, 0);

const blankTokenMap = () =>
  TOKENS.reduce((acc, token) => ({ ...acc, [token.id]: 0 }), {} as TokenMap);

const cloneTokenMap = (map: TokenMap) =>
  Object.keys(map).reduce(
    (acc, key) => ({ ...acc, [key]: map[key] }),
    {} as TokenMap
  );

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const collectFromBalances = (
  balances: TokenMap,
  amount: number,
  preferences: string[]
) => {
  let remaining = roundAmount(amount);
  const taken = blankTokenMap();

  const order = [...preferences, ...TOKENS.map(t => t.id)].filter(
    (value, index, self) => self.indexOf(value) === index
  );

  for (const tokenId of order) {
    if (remaining <= 0) break;
    const available = balances[tokenId] || 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    balances[tokenId] = roundAmount(available - take);
    taken[tokenId] = roundAmount(taken[tokenId] + take);
    remaining = roundAmount(remaining - take);
  }

  return { taken, ok: remaining <= 0.0001 };
};

const consumeFromTokenMap = (
  map: TokenMap,
  amount: number,
  preferences: string[]
) => {
  let remaining = roundAmount(amount);
  const order = [...preferences, ...TOKENS.map(t => t.id)].filter(
    (value, index, self) => self.indexOf(value) === index
  );

  for (const tokenId of order) {
    if (remaining <= 0) break;
    const available = map[tokenId] || 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    map[tokenId] = roundAmount(available - take);
    remaining = roundAmount(remaining - take);
  }
};

const matchSwaps = (swaps: Swap[]) => {
  const updated = swaps.map(s => ({ ...s }));
  for (let i = 0; i < updated.length; i++) {
    const a = updated[i];
    if (a.status !== 'open' || a.matchedId) continue;
    for (let j = i + 1; j < updated.length; j++) {
      const b = updated[j];
      if (b.status !== 'open' || b.matchedId) continue;
      if (a.maker === b.maker) continue;
      const isMatch =
        a.sendToken === b.receiveToken &&
        a.receiveToken === b.sendToken &&
        roundAmount(a.sendAmount) === roundAmount(b.receiveAmount) &&
        roundAmount(a.receiveAmount) === roundAmount(b.sendAmount);
      if (isMatch) {
        a.status = 'matched';
        b.status = 'matched';
        a.matchedId = b.id;
        b.matchedId = a.id;
        break;
      }
    }
  }
  return updated;
};

const resolveDvPPaymentToken = (order: DvP, byId: Map<string, DvP>) => {
  if (order.side === 'buy') return order.paymentToken;
  if (order.matchedId) {
    const matched = byId.get(order.matchedId);
    if (matched && matched.side === 'buy') return matched.paymentToken;
  }
  if (order.paymentToken) return order.paymentToken;
  if (order.sellTerms) {
    const token = Object.keys(order.sellTerms)[0];
    if (token) return token;
  }
  return TOKENS[0]?.id ?? '';
};

const formatDvPTerms = (order: DvP) => {
  if (order.side === 'buy') return `${order.price} ${order.paymentToken}`;
  const terms = order.sellTerms ?? {};
  const entries = Object.entries(terms);
  if (entries.length === 0) return `${order.price} (no token terms)`;
  return entries.map(([token, price]) => `${price} ${token}`).join(', ');
};

const matchDvps = (dvps: DvP[]) => {
  const updated = dvps.map(d => ({
    ...d,
    sellTerms: d.sellTerms ? { ...d.sellTerms } : d.sellTerms,
  }));
  for (let i = 0; i < updated.length; i++) {
    const a = updated[i];
    if (a.status !== 'open' || a.matchedId) continue;
    for (let j = i + 1; j < updated.length; j++) {
      const b = updated[j];
      if (b.status !== 'open' || b.matchedId) continue;
      if (a.maker === b.maker) continue;
      const sides = a.side !== b.side;
      const sameAsset = a.assetId === b.assetId;
      const samePrice = roundAmount(a.price) === roundAmount(b.price);
      if (!sides || !sameAsset || !samePrice) continue;
      if (!a.counterparty || !b.counterparty) continue;
      const counterpartyOk = a.counterparty === b.maker && b.counterparty === a.maker;
      if (!counterpartyOk) continue;

      const buy = a.side === 'buy' ? a : b;
      const sell = a.side === 'sell' ? a : b;
      const terms = sell.sellTerms ?? {};
      const termPrice = terms[buy.paymentToken];
      if (termPrice !== undefined && roundAmount(termPrice) !== roundAmount(buy.price)) {
        continue;
      }
      if (termPrice === undefined) {
        sell.sellTerms = { ...terms, [buy.paymentToken]: buy.price };
      }

      if (sell.sellTerms && sell.sellTerms[buy.paymentToken] === undefined) {
        continue;
      }

      if (counterpartyOk) {
        a.status = 'matched';
        b.status = 'matched';
        a.matchedId = b.id;
        b.matchedId = a.id;
        break;
      }
    }
  }
  return updated;
};

const runSettlementSimulation = ({
  users,
  payments,
  swaps,
  dvps,
  stakeBps,
}: {
  users: User[];
  payments: Payment[];
  swaps: Swap[];
  dvps: DvP[];
  stakeBps: number;
}) => {
  const steps: string[] = [];
  const reportId = createId('cycle');
  const startedAt = new Date().toLocaleTimeString();

  const usersById = new Map(users.map(u => [u.id, u]));
  const excludedUsers = new Set<string>();

  let currentPayments = payments.map(p => ({ ...p }));
  let currentSwaps = matchSwaps(swaps);
  let currentDvps = matchDvps(dvps);

  let finalBalances = users.map(u => ({
    ...u,
    balances: cloneTokenMap(u.balances),
  }));

  let rounds = 0;
  let settledPayments = 0;
  let settledSwaps = 0;
  let settledDvps = 0;

  const buildActive = () => {
    const activePayments = currentPayments.filter(
      p => p.status === 'accepted' && !excludedUsers.has(p.sender) && !excludedUsers.has(p.recipient)
    );
    const activeSwaps = currentSwaps.filter(
      s => s.status === 'matched' && !excludedUsers.has(s.maker)
    );
    const activeDvps = currentDvps.filter(
      d =>
        d.status === 'matched' &&
        !excludedUsers.has(d.maker) &&
        (!d.counterparty || !excludedUsers.has(d.counterparty))
    );
    return { activePayments, activeSwaps, activeDvps };
  };

  let lastReport: SettlementReport | null = null;

  while (rounds < 3) {
    rounds += 1;
    const { activePayments, activeSwaps, activeDvps } = buildActive();

    const participants = new Set<string>();
    for (const payment of activePayments) {
      participants.add(payment.sender);
      participants.add(payment.recipient);
    }
    for (const swap of activeSwaps) {
      participants.add(swap.maker);
    }
    for (const dvp of activeDvps) {
      participants.add(dvp.maker);
      if (dvp.counterparty) participants.add(dvp.counterparty);
    }

    if (participants.size === 0) {
      steps.push('No eligible transactions for this settlement cycle.');
      break;
    }

    steps.push(
      `Round ${rounds}: ${participants.size} participant(s), ${activePayments.length} payment(s), ${activeSwaps.length} swap(s), ${activeDvps.length} DvP order(s).`
    );

    const balances = new Map(
      finalBalances.map(u => [u.id, cloneTokenMap(u.balances)])
    );

    const grossOutgoing: Record<string, number> = {};
    const perTokenNet: Record<string, TokenMap> = {};
    const netPositions: Record<string, number> = {};
    const stakeCollected: Record<string, TokenMap> = {};
    const lockCollected: Record<string, TokenMap> = {};
    const payouts: Record<string, TokenMap> = {};
    const stakeRefunds: Record<string, TokenMap> = {};
    const poolBeforePayout = blankTokenMap();
    const poolAfterPayout = blankTokenMap();

    const ensureUser = (userId: string) => {
      if (!grossOutgoing[userId]) grossOutgoing[userId] = 0;
      if (!perTokenNet[userId]) perTokenNet[userId] = blankTokenMap();
      if (!netPositions[userId]) netPositions[userId] = 0;
      if (!stakeCollected[userId]) stakeCollected[userId] = blankTokenMap();
      if (!lockCollected[userId]) lockCollected[userId] = blankTokenMap();
      if (!payouts[userId]) payouts[userId] = blankTokenMap();
      if (!stakeRefunds[userId]) stakeRefunds[userId] = blankTokenMap();
    };

    for (const userId of participants) ensureUser(userId);

    for (const payment of activePayments) {
      ensureUser(payment.sender);
      ensureUser(payment.recipient);
      grossOutgoing[payment.sender] = roundAmount(
        grossOutgoing[payment.sender] + payment.amount
      );
      perTokenNet[payment.sender][payment.token] = roundAmount(
        perTokenNet[payment.sender][payment.token] - payment.amount
      );
      perTokenNet[payment.recipient][payment.token] = roundAmount(
        perTokenNet[payment.recipient][payment.token] + payment.amount
      );
    }

    for (const swap of activeSwaps) {
      ensureUser(swap.maker);
      grossOutgoing[swap.maker] = roundAmount(
        grossOutgoing[swap.maker] + swap.sendAmount
      );
      perTokenNet[swap.maker][swap.sendToken] = roundAmount(
        perTokenNet[swap.maker][swap.sendToken] - swap.sendAmount
      );
      perTokenNet[swap.maker][swap.receiveToken] = roundAmount(
        perTokenNet[swap.maker][swap.receiveToken] + swap.receiveAmount
      );
    }

    const dvpById = new Map(currentDvps.map(dvp => [dvp.id, dvp]));
    for (const dvp of activeDvps) {
      ensureUser(dvp.maker);
      const paymentToken = resolveDvPPaymentToken(dvp, dvpById);
      if (dvp.side === 'buy') {
        grossOutgoing[dvp.maker] = roundAmount(
          grossOutgoing[dvp.maker] + dvp.price
        );
        perTokenNet[dvp.maker][paymentToken] = roundAmount(
          perTokenNet[dvp.maker][paymentToken] - dvp.price
        );
      } else {
        perTokenNet[dvp.maker][paymentToken] = roundAmount(
          perTokenNet[dvp.maker][paymentToken] + dvp.price
        );
      }
    }

    for (const userId of Object.keys(perTokenNet)) {
      netPositions[userId] = roundAmount(sumTokens(perTokenNet[userId]));
    }

    const defaulters: string[] = [];
    for (const userId of participants) {
      const user = usersById.get(userId);
      if (!user) continue;
      const stake = roundAmount((grossOutgoing[userId] || 0) * (stakeBps / 10000));
      if (stake <= 0) {
        steps.push(`Stake: ${user.name} has no gross outgoing; stake skipped.`);
        continue;
      }
      const userBalances = balances.get(userId);
      if (!userBalances) continue;
      const { taken, ok } = collectFromBalances(
        userBalances,
        stake,
        user.preferences
      );
      stakeCollected[userId] = taken;
      for (const tokenId of Object.keys(taken)) {
        poolBeforePayout[tokenId] = roundAmount(
          poolBeforePayout[tokenId] + taken[tokenId]
        );
      }
      if (!ok) {
        defaulters.push(userId);
      }
    }

    if (defaulters.length > 0) {
      defaulters.forEach(id => excludedUsers.add(id));
      steps.push(
        `Stake failure: excluded ${defaulters
          .map(id => usersById.get(id)?.name || id)
          .join(', ')}. Re-netting remaining participants.`
      );
      continue;
    }

    for (const userId of participants) {
      const net = netPositions[userId] || 0;
      if (net >= 0) continue;
      const user = usersById.get(userId);
      if (!user) continue;
      const userBalances = balances.get(userId);
      if (!userBalances) continue;

      const stakeValue = sumTokens(stakeCollected[userId] || blankTokenMap());
      let remaining = roundAmount(-net);
      const stakeUsed = Math.min(remaining, stakeValue);
      remaining = roundAmount(remaining - stakeUsed);

      if (remaining > 0) {
        const { taken, ok } = collectFromBalances(
          userBalances,
          remaining,
          user.preferences
        );
        lockCollected[userId] = taken;
        for (const tokenId of Object.keys(taken)) {
          poolBeforePayout[tokenId] = roundAmount(
            poolBeforePayout[tokenId] + taken[tokenId]
          );
        }
        if (!ok) {
          defaulters.push(userId);
        }
      }

      if (stakeUsed > 0) {
        const stakeMap = cloneTokenMap(stakeCollected[userId] || blankTokenMap());
        consumeFromTokenMap(stakeMap, stakeUsed, user.preferences);
        const remainingStake = stakeMap;
        stakeRefunds[userId] = remainingStake;
      }
    }

    if (defaulters.length > 0) {
      defaulters.forEach(id => excludedUsers.add(id));
      steps.push(
        `Lock failure: excluded ${defaulters
          .map(id => usersById.get(id)?.name || id)
          .join(', ')}. Re-netting remaining participants.`
      );
      continue;
    }

    const pool = cloneTokenMap(poolBeforePayout);
    for (const userId of participants) {
      const net = netPositions[userId] || 0;
      if (net <= 0) continue;
      const user = usersById.get(userId);
      if (!user) continue;
      let remaining = roundAmount(net);
      const order = [...user.preferences, ...TOKENS.map(t => t.id)].filter(
        (value, index, self) => self.indexOf(value) === index
      );
      for (const tokenId of order) {
        if (remaining <= 0) break;
        const available = pool[tokenId] || 0;
        if (available <= 0) continue;
        const take = Math.min(available, remaining);
        pool[tokenId] = roundAmount(available - take);
        payouts[userId][tokenId] = roundAmount(
          payouts[userId][tokenId] + take
        );
        remaining = roundAmount(remaining - take);
      }
    }

    for (const userId of participants) {
      const user = usersById.get(userId);
      if (!user) continue;
      const userBalances = balances.get(userId);
      if (!userBalances) continue;
      const refund = stakeRefunds[userId] || blankTokenMap();
      for (const tokenId of Object.keys(refund)) {
        const amount = refund[tokenId];
        if (amount > 0) {
          userBalances[tokenId] = roundAmount(userBalances[tokenId] + amount);
          pool[tokenId] = roundAmount(pool[tokenId] - amount);
        }
      }
      const payout = payouts[userId] || blankTokenMap();
      for (const tokenId of Object.keys(payout)) {
        const amount = payout[tokenId];
        if (amount > 0) {
          userBalances[tokenId] = roundAmount(userBalances[tokenId] + amount);
        }
      }
    }

    for (const tokenId of Object.keys(pool)) {
      poolAfterPayout[tokenId] = pool[tokenId];
    }

    const newUsers = finalBalances.map(user => ({
      ...user,
      balances: balances.get(user.id) || cloneTokenMap(user.balances),
    }));

    finalBalances = newUsers;

    currentPayments = currentPayments.map(p => {
      if (p.status === 'accepted' && !excludedUsers.has(p.sender) && !excludedUsers.has(p.recipient)) {
        settledPayments += 1;
        return { ...p, status: 'settled' };
      }
      if (excludedUsers.has(p.sender) || excludedUsers.has(p.recipient)) {
        return { ...p, status: 'excluded' };
      }
      return p;
    });

    currentSwaps = currentSwaps.map(s => {
      if (s.status === 'matched' && !excludedUsers.has(s.maker)) {
        settledSwaps += 1;
        return { ...s, status: 'settled' };
      }
      if (excludedUsers.has(s.maker)) {
        return { ...s, status: 'excluded' };
      }
      return s;
    });

    currentDvps = currentDvps.map(d => {
      if (d.status === 'matched' && !excludedUsers.has(d.maker)) {
        settledDvps += 1;
        return { ...d, status: 'settled' };
      }
      if (excludedUsers.has(d.maker)) {
        return { ...d, status: 'excluded' };
      }
      return d;
    });

    steps.push('Settlement completed and balances updated.');
    lastReport = {
      id: reportId,
      startedAt,
      rounds,
      participants: Array.from(participants),
      excludedUsers: Array.from(excludedUsers),
      grossOutgoing,
      perTokenNet,
      netPositions,
      stakeCollected,
      lockCollected,
      poolBeforePayout,
      payouts,
      stakeRefunds,
      poolAfterPayout,
      transactionsSettled: {
        payments: settledPayments,
        swaps: settledSwaps,
        dvps: settledDvps,
      },
      steps,
    };
    break;
  }

  if (!lastReport) {
    lastReport = {
      id: reportId,
      startedAt,
      rounds,
      participants: [],
      excludedUsers: Array.from(excludedUsers),
      grossOutgoing: {},
      perTokenNet: {},
      netPositions: {},
      stakeCollected: {},
      lockCollected: {},
      poolBeforePayout: blankTokenMap(),
      payouts: {},
      stakeRefunds: {},
      poolAfterPayout: blankTokenMap(),
      transactionsSettled: { payments: 0, swaps: 0, dvps: 0 },
      steps,
    };
  }

  return {
    users: finalBalances,
    payments: currentPayments,
    swaps: currentSwaps,
    dvps: currentDvps,
    report: lastReport,
  };
};

export default function App() {
  const [users, setUsers] = useState<User[]>(DEFAULT_USERS);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [dvps, setDvps] = useState<DvP[]>([]);
  const [reports, setReports] = useState<SettlementReport[]>([]);
  const [stakeBps, setStakeBps] = useState(2000);
  const [autoMode, setAutoMode] = useState(false);

  const stateRef = useRef({ users, payments, swaps, dvps });
  useEffect(() => {
    stateRef.current = { users, payments, swaps, dvps };
  }, [users, payments, swaps, dvps]);

  const [newPayment, setNewPayment] = useState({
    sender: 'U1',
    recipient: 'U2',
    amount: 50,
    token: 'TKA',
  });
  const [newSwap, setNewSwap] = useState({
    maker: 'U1',
    sendToken: 'TKA',
    sendAmount: 40,
    receiveToken: 'TKB',
    receiveAmount: 38,
  });
  const [newDvP, setNewDvP] = useState({
    maker: 'U1',
    side: 'sell' as 'sell' | 'buy',
    assetId: 1,
    paymentToken: 'TKA',
    price: 120,
    counterparty: '',
  });
  const [dvpError, setDvpError] = useState<string | null>(null);

  const addPayment = useCallback(() => {
    const payment: Payment = {
      id: createId('pay'),
      sender: newPayment.sender,
      recipient: newPayment.recipient,
      amount: roundAmount(newPayment.amount),
      token: newPayment.token,
      status: 'requested',
    };
    setPayments(prev => [payment, ...prev]);
  }, [newPayment]);

  const addSwap = useCallback(() => {
    const swap: Swap = {
      id: createId('swap'),
      maker: newSwap.maker,
      sendToken: newSwap.sendToken,
      sendAmount: roundAmount(newSwap.sendAmount),
      receiveToken: newSwap.receiveToken,
      receiveAmount: roundAmount(newSwap.receiveAmount),
      status: 'open',
    };
    setSwaps(prev => [swap, ...prev]);
  }, [newSwap]);

  const addDvP = useCallback(() => {
    const counterparty = newDvP.counterparty.trim();
    if (!counterparty) {
      setDvpError('Counterparty required for DvP orders.');
      return;
    }
    if (counterparty === newDvP.maker) {
      setDvpError('Counterparty must be different from maker.');
      return;
    }
    const price = roundAmount(newDvP.price);
    const isBuy = newDvP.side === 'buy';
    const paymentToken = isBuy ? newDvP.paymentToken : '';

    const existing = stateRef.current.dvps;
    if (isBuy) {
      const conflictingSell = existing.find(order => {
        if (order.side !== 'sell') return false;
        if (order.status !== 'open') return false;
        if (order.assetId !== newDvP.assetId) return false;
        if (order.maker !== counterparty) return false;
        if (order.counterparty !== newDvP.maker) return false;
        const term = order.sellTerms?.[paymentToken];
        return term !== undefined && roundAmount(term) !== price;
      });
      if (conflictingSell) {
        setDvpError('Sell order terms mismatch for this asset/token.');
        return;
      }
    } else {
      const conflictingBuy = existing.find(order => {
        if (order.side !== 'buy') return false;
        if (order.status !== 'open') return false;
        if (order.assetId !== newDvP.assetId) return false;
        if (order.maker !== counterparty) return false;
        if (order.counterparty !== newDvP.maker) return false;
        return roundAmount(order.price) !== price;
      });
      if (conflictingBuy) {
        setDvpError('Buy order price must match sell order.');
        return;
      }
    }

    setDvpError(null);
    const order: DvP = {
      id: createId('dvp'),
      maker: newDvP.maker,
      side: newDvP.side,
      assetId: newDvP.assetId,
      paymentToken,
      price,
      counterparty,
      status: 'open',
      sellTerms: newDvP.side === 'sell' ? {} : undefined,
    };

    setDvps(prev => {
      const next = prev.map(existingOrder => ({
        ...existingOrder,
        sellTerms: existingOrder.sellTerms
          ? { ...existingOrder.sellTerms }
          : existingOrder.sellTerms,
      }));

      if (isBuy) {
        for (const existingOrder of next) {
          if (existingOrder.side !== 'sell') continue;
          if (existingOrder.status !== 'open') continue;
          if (existingOrder.assetId !== order.assetId) continue;
          if (existingOrder.maker !== counterparty) continue;
          if (existingOrder.counterparty !== order.maker) continue;
          const terms = existingOrder.sellTerms ?? {};
          if (terms[paymentToken] === undefined) {
            existingOrder.sellTerms = { ...terms, [paymentToken]: price };
          }
        }
      } else {
        const sellTerms: Record<string, number> = {};
        for (const existingOrder of next) {
          if (existingOrder.side !== 'buy') continue;
          if (existingOrder.status !== 'open') continue;
          if (existingOrder.assetId !== order.assetId) continue;
          if (existingOrder.maker !== counterparty) continue;
          if (existingOrder.counterparty !== order.maker) continue;
          if (roundAmount(existingOrder.price) !== price) continue;
          sellTerms[existingOrder.paymentToken] = price;
        }
        order.sellTerms = sellTerms;
      }

      return [order, ...next];
    });
  }, [newDvP]);

  const acceptPayment = (id: string) => {
    setPayments(prev =>
      prev.map(p => (p.id === id ? { ...p, status: 'accepted' } : p))
    );
  };

  const acceptAllPayments = () => {
    setPayments(prev =>
      prev.map(p => (p.status === 'requested' ? { ...p, status: 'accepted' } : p))
    );
  };

  const runSettlement = useCallback(() => {
    const result = runSettlementSimulation({
      users: stateRef.current.users,
      payments: stateRef.current.payments,
      swaps: stateRef.current.swaps,
      dvps: stateRef.current.dvps,
      stakeBps,
    });
    setUsers(result.users);
    setPayments(result.payments);
    setSwaps(result.swaps);
    setDvps(result.dvps);
    setReports(prev => [result.report, ...prev].slice(0, 5));
  }, [stakeBps]);

  const clearSettled = () => {
    setPayments(prev => prev.filter(p => p.status !== 'settled'));
    setSwaps(prev => prev.filter(s => s.status !== 'settled'));
    setDvps(prev => prev.filter(d => d.status !== 'settled'));
  };

  const resetScenario = () => {
    setUsers(DEFAULT_USERS);
    setPayments([]);
    setSwaps([]);
    setDvps([]);
    setReports([]);
  };

  const updatePreference = (userId: string, tokenId: string, direction: 'up' | 'down') => {
    setUsers(prev =>
      prev.map(user => {
        if (user.id !== userId) return user;
        const idx = user.preferences.indexOf(tokenId);
        if (idx === -1) return user;
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= user.preferences.length) return user;
        const next = [...user.preferences];
        [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
        return { ...user, preferences: next };
      })
    );
  };

  const applyScenario = (scenario: 'mixed' | 'multi-token' | 'defaulter') => {
    const baseUsers = DEFAULT_USERS.map(u => ({
      ...u,
      balances: cloneTokenMap(u.balances),
    }));
    if (scenario === 'defaulter') {
      baseUsers[0].balances.TKA = 30;
    }
    setUsers(baseUsers);

    if (scenario === 'mixed') {
      setPayments([
        {
          id: createId('pay'),
          sender: 'U1',
          recipient: 'U2',
          amount: 10,
          token: 'TKB',
          status: 'accepted',
        },
        {
          id: createId('pay'),
          sender: 'U3',
          recipient: 'U4',
          amount: 7,
          token: 'TKC',
          status: 'accepted',
        },
      ]);
      setSwaps([
        {
          id: createId('swap'),
          maker: 'U1',
          sendToken: 'TKA',
          sendAmount: 5,
          receiveToken: 'TKB',
          receiveAmount: 6,
          status: 'open',
        },
        {
          id: createId('swap'),
          maker: 'U3',
          sendToken: 'TKB',
          sendAmount: 6,
          receiveToken: 'TKA',
          receiveAmount: 5,
          status: 'open',
        },
      ]);
      setDvps([
        {
          id: createId('dvp'),
          maker: 'U1',
          side: 'sell',
          assetId: 1,
          paymentToken: '',
          price: 12,
          counterparty: 'U3',
          status: 'open',
          sellTerms: { TKB: 12 },
        },
        {
          id: createId('dvp'),
          maker: 'U3',
          side: 'buy',
          assetId: 1,
          paymentToken: 'TKB',
          price: 12,
          counterparty: 'U1',
          status: 'open',
        },
      ]);
    } else if (scenario === 'multi-token') {
      setPayments([
        {
          id: createId('pay'),
          sender: 'U1',
          recipient: 'U2',
          amount: 8,
          token: 'TKB',
          status: 'accepted',
        },
        {
          id: createId('pay'),
          sender: 'U3',
          recipient: 'U4',
          amount: 5,
          token: 'TKC',
          status: 'accepted',
        },
        {
          id: createId('pay'),
          sender: 'U5',
          recipient: 'U2',
          amount: 4,
          token: 'TKA',
          status: 'accepted',
        },
      ]);
      setSwaps([
        {
          id: createId('swap'),
          maker: 'U1',
          sendToken: 'TKA',
          sendAmount: 3,
          receiveToken: 'TKB',
          receiveAmount: 4,
          status: 'open',
        },
        {
          id: createId('swap'),
          maker: 'U5',
          sendToken: 'TKB',
          sendAmount: 4,
          receiveToken: 'TKA',
          receiveAmount: 3,
          status: 'open',
        },
        {
          id: createId('swap'),
          maker: 'U4',
          sendToken: 'TKC',
          sendAmount: 2,
          receiveToken: 'TKA',
          receiveAmount: 2,
          status: 'open',
        },
        {
          id: createId('swap'),
          maker: 'U2',
          sendToken: 'TKA',
          sendAmount: 2,
          receiveToken: 'TKC',
          receiveAmount: 2,
          status: 'open',
        },
      ]);
      setDvps([
        {
          id: createId('dvp'),
          maker: 'U1',
          side: 'sell',
          assetId: 1,
          paymentToken: '',
          price: 9,
          counterparty: 'U3',
          status: 'open',
          sellTerms: { TKC: 9 },
        },
        {
          id: createId('dvp'),
          maker: 'U3',
          side: 'buy',
          assetId: 1,
          paymentToken: 'TKC',
          price: 9,
          counterparty: 'U1',
          status: 'open',
        },
      ]);
    } else {
      setPayments([
        {
          id: createId('pay'),
          sender: 'U1',
          recipient: 'U2',
          amount: 20,
          token: 'TKA',
          status: 'accepted',
        },
        {
          id: createId('pay'),
          sender: 'U3',
          recipient: 'U4',
          amount: 6,
          token: 'TKA',
          status: 'accepted',
        },
      ]);
      setSwaps([]);
      setDvps([]);
    }
    setReports([]);
  };

  const addRandomTransaction = () => {
    const userIds = users.map(u => u.id);
    const pick = () => userIds[Math.floor(Math.random() * userIds.length)];
    const tokenPick = () => TOKENS[Math.floor(Math.random() * TOKENS.length)].id;
    const type = Math.random();

    if (type < 0.35) {
      let sender = pick();
      let recipient = pick();
      while (recipient === sender) recipient = pick();
      setPayments(prev => [
        {
          id: createId('pay'),
          sender,
          recipient,
          amount: roundAmount(5 + Math.random() * 20),
          token: tokenPick(),
          status: 'accepted',
        },
        ...prev,
      ]);
    } else if (type < 0.7) {
      const maker = pick();
      const sendToken = tokenPick();
      const receiveToken = tokenPick();
      const sendAmount = roundAmount(4 + Math.random() * 12);
      const receiveAmount = roundAmount(sendAmount * (0.9 + Math.random() * 0.2));
      setSwaps(prev => [
        {
          id: createId('swap'),
          maker,
          sendToken,
          sendAmount,
          receiveToken,
          receiveAmount,
          status: 'open',
        },
        ...prev,
      ]);
    } else {
      const maker = pick();
      const side = Math.random() > 0.5 ? 'buy' : 'sell';
      const assetId = 1 + Math.floor(Math.random() * 3);
      let counterparty = pick();
      while (counterparty === maker) counterparty = pick();
      const paymentToken = tokenPick();
      const price = roundAmount(10 + Math.random() * 40);
      setDvps(prev => [
        {
          id: createId('dvp'),
          maker,
          side,
          assetId,
          paymentToken: side === 'buy' ? paymentToken : '',
          price,
          counterparty,
          status: 'open',
          sellTerms: side === 'sell' ? { [paymentToken]: price } : undefined,
        },
        ...prev,
      ]);
    }
  };

  useEffect(() => {
    if (!autoMode) return;
    const txTimer = setInterval(addRandomTransaction, 1500);
    const settleTimer = setInterval(runSettlement, 7000);
    return () => {
      clearInterval(txTimer);
      clearInterval(settleTimer);
    };
  }, [autoMode, runSettlement, users]);

  const latestReport = reports[0];

  return (
    <div className="app">
      <aside className="panel sidebar">
        <h1>ClearingHouse Demo</h1>
        <p className="muted">
          Client-side simulation of payments, swaps, and DvP settlement with
          ranked stablecoin preferences.
        </p>

        <section>
          <h2>Scenario Presets</h2>
          <div className="button-row">
            <button onClick={() => applyScenario('mixed')}>Mixed Batch</button>
            <button onClick={() => applyScenario('multi-token')}>Multi-Token</button>
            <button onClick={() => applyScenario('defaulter')}>Defaulter</button>
          </div>
          <div className="button-row">
            <button onClick={resetScenario} className="ghost">Reset</button>
          </div>
        </section>

        <section>
          <h2>Settlement Controls</h2>
          <label className="input-row">
            <span>Stake BPS</span>
            <input
              type="number"
              min={0}
              max={10000}
              step={100}
              value={stakeBps}
              onChange={e => setStakeBps(Number(e.target.value))}
            />
          </label>
          <div className="button-row">
            <button onClick={runSettlement} className="primary">Run Settlement</button>
            <button onClick={clearSettled} className="ghost">Clear Settled</button>
          </div>
          <div className="button-row">
            <button onClick={() => setAutoMode(v => !v)} className={autoMode ? 'danger' : ''}>
              {autoMode ? 'Stop Auto-Run' : 'Start Auto-Run'}
            </button>
          </div>
        </section>

        <section>
          <h2>Payments</h2>
          <div className="form-grid">
            <select
              value={newPayment.sender}
              onChange={e => setNewPayment(p => ({ ...p, sender: e.target.value }))}
            >
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select
              value={newPayment.recipient}
              onChange={e => setNewPayment(p => ({ ...p, recipient: e.target.value }))}
            >
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <input
              type="number"
              min={1}
              value={newPayment.amount}
              onChange={e => setNewPayment(p => ({ ...p, amount: Number(e.target.value) }))}
            />
            <select
              value={newPayment.token}
              onChange={e => setNewPayment(p => ({ ...p, token: e.target.value }))}
            >
              {TOKENS.map(t => <option key={t.id} value={t.id}>{t.symbol}</option>)}
            </select>
          </div>
          <div className="button-row">
            <button onClick={addPayment}>Add Payment</button>
            <button onClick={acceptAllPayments} className="ghost">Accept All</button>
          </div>
        </section>

        <section>
          <h2>Swaps</h2>
          <div className="form-grid">
            <select
              value={newSwap.maker}
              onChange={e => setNewSwap(s => ({ ...s, maker: e.target.value }))}
            >
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select
              value={newSwap.sendToken}
              onChange={e => setNewSwap(s => ({ ...s, sendToken: e.target.value }))}
            >
              {TOKENS.map(t => <option key={t.id} value={t.id}>{t.symbol}</option>)}
            </select>
            <input
              type="number"
              min={1}
              value={newSwap.sendAmount}
              onChange={e => setNewSwap(s => ({ ...s, sendAmount: Number(e.target.value) }))}
            />
            <select
              value={newSwap.receiveToken}
              onChange={e => setNewSwap(s => ({ ...s, receiveToken: e.target.value }))}
            >
              {TOKENS.map(t => <option key={t.id} value={t.id}>{t.symbol}</option>)}
            </select>
            <input
              type="number"
              min={1}
              value={newSwap.receiveAmount}
              onChange={e => setNewSwap(s => ({ ...s, receiveAmount: Number(e.target.value) }))}
            />
          </div>
          <div className="button-row">
            <button onClick={addSwap}>Add Swap</button>
          </div>
        </section>

        <section>
          <h2>DvP Orders</h2>
          <div className="form-grid">
            <select
              value={newDvP.maker}
              onChange={e => setNewDvP(s => ({ ...s, maker: e.target.value }))}
            >
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select
              value={newDvP.side}
              onChange={e =>
                setNewDvP(s => ({ ...s, side: e.target.value as 'buy' | 'sell' }))
              }
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
            <input
              type="number"
              min={1}
              value={newDvP.assetId}
              onChange={e => setNewDvP(s => ({ ...s, assetId: Number(e.target.value) }))}
            />
            <select
              value={newDvP.paymentToken}
              onChange={e => setNewDvP(s => ({ ...s, paymentToken: e.target.value }))}
              disabled={newDvP.side === 'sell'}
            >
              {TOKENS.map(t => <option key={t.id} value={t.id}>{t.symbol}</option>)}
            </select>
            <input
              type="number"
              min={1}
              value={newDvP.price}
              onChange={e => setNewDvP(s => ({ ...s, price: Number(e.target.value) }))}
            />
            <select
              value={newDvP.counterparty}
              onChange={e => setNewDvP(s => ({ ...s, counterparty: e.target.value }))}
            >
              <option value="">Select counterparty</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="button-row">
            <button onClick={addDvP} disabled={!newDvP.counterparty.trim()}>
              Add DvP
            </button>
          </div>
          {dvpError && <p className="muted">{dvpError}</p>}
          <p className="muted">
            Buy orders specify the payment token; sell orders define terms once a counterparty is set.
          </p>
        </section>

        <section>
          <h2>Users & Preferences</h2>
          <div className="user-list">
            {users.map(user => (
              <div key={user.id} className="user-card">
                <div className="user-title">{user.name}</div>
                <div className="token-grid">
                  {TOKENS.map(token => (
                    <div key={token.id} className="token-chip">
                      <span style={{ color: token.color }}>{token.symbol}</span>
                      <span>{user.balances[token.id].toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div className="pref-list">
                  {user.preferences.map((pref, idx) => (
                    <div key={`${user.id}-${pref}`} className="pref-row">
                      <span>{idx + 1}. {pref}</span>
                      <div className="pref-actions">
                        <button
                          onClick={() => updatePreference(user.id, pref, 'up')}
                          disabled={idx === 0}
                        >
                          Up
                        </button>
                        <button
                          onClick={() => updatePreference(user.id, pref, 'down')}
                          disabled={idx === user.preferences.length - 1}
                        >
                          Down
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </aside>

      <main className="main">
        <section className="panel graph-panel">
          <h2>Flow Graph</h2>
          <FlowGraph
            users={users}
            payments={payments}
            swaps={swaps}
            dvps={dvps}
          />
          <div className="legend">
            {TOKENS.map(token => (
              <div key={token.id} className="legend-item">
                <span className="legend-color" style={{ background: token.color }} />
                {token.symbol}
              </div>
            ))}
          </div>
        </section>

        <section className="panel transactions">
          <h2>Transactions</h2>
          <div className="transaction-grid">
            <div>
              <h3>Payments</h3>
              {payments.length === 0 && <p className="muted">No payments.</p>}
              {payments.map(payment => (
                <div key={payment.id} className={`card status-${payment.status}`}>
                  <div className="card-row">
                    <span>{payment.sender} -&gt; {payment.recipient}</span>
                    <span>{payment.amount} {payment.token}</span>
                  </div>
                  <div className="card-row">
                    <span>Status: {payment.status}</span>
                    {payment.status === 'requested' && (
                      <button onClick={() => acceptPayment(payment.id)}>Accept</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <h3>Swaps</h3>
              {swaps.length === 0 && <p className="muted">No swaps.</p>}
              {swaps.map(swap => (
                <div key={swap.id} className={`card status-${swap.status}`}>
                  <div className="card-row">
                    <span>{swap.maker}</span>
                    <span>
                      {swap.sendAmount} {swap.sendToken} -&gt; {swap.receiveAmount} {swap.receiveToken}
                    </span>
                  </div>
                  <div className="card-row">
                    <span>Status: {swap.status}</span>
                    {swap.matchedId && <span>Match: {swap.matchedId.slice(-4)}</span>}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <h3>DvP Orders</h3>
              {dvps.length === 0 && <p className="muted">No DvP orders.</p>}
              {dvps.map(order => (
                <div key={order.id} className={`card status-${order.status}`}>
                  <div className="card-row">
                    <span>{order.maker}</span>
                    <span>{order.side.toUpperCase()} Asset {order.assetId}</span>
                  </div>
                  <div className="card-row">
                    <span>{formatDvPTerms(order)}</span>
                    <span>Status: {order.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <aside className="panel details">
        <h2>Settlement Cycle</h2>
        {!latestReport && <p className="muted">Run a settlement to see details.</p>}
        {latestReport && (
          <>
            <div className="summary">
              <div><strong>Started</strong>: {latestReport.startedAt}</div>
              <div><strong>Rounds</strong>: {latestReport.rounds}</div>
              <div><strong>Settled</strong>: {latestReport.transactionsSettled.payments} payments, {latestReport.transactionsSettled.swaps} swaps, {latestReport.transactionsSettled.dvps} DvP</div>
              {latestReport.excludedUsers.length > 0 && (
                <div><strong>Excluded</strong>: {latestReport.excludedUsers.join(', ')}</div>
              )}
            </div>

            <h3>1. Cycle Steps</h3>
            <ul className="steps">
              {latestReport.steps.map((step, idx) => (
                <li key={`${latestReport.id}-${idx}`}>{step}</li>
              ))}
            </ul>

            <h3>2. Stake Collected</h3>
            <div className="table">
              <div className="table-row header">
                <span>User</span>
                <span>Collected</span>
                {TOKENS.map(token => (
                  <span key={`stake-header-${token.id}`}>{token.symbol}</span>
                ))}
              </div>
              {latestReport.participants.length === 0 && (
                <div className="table-row">
                  <span className="muted">No participants were eligible.</span>
                </div>
              )}
              {latestReport.participants.map(userId => {
                const collected = latestReport.stakeCollected[userId] || blankTokenMap();
                return (
                  <div key={`stake-${userId}`} className="table-row">
                    <span>{userId}</span>
                    <span>{sumTokens(collected).toFixed(2)}</span>
                    {TOKENS.map(token => (
                      <span key={`${userId}-stake-${token.id}`}>
                        {(collected[token.id] || 0).toFixed(2)}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>

            <h3>3. Net & Locked</h3>
            <div className="table">
              <div className="table-row header">
                <span>User</span>
                <span>Net</span>
                <span>Locked</span>
                <span>Gross</span>
              </div>
              {Object.keys(latestReport.netPositions).map(userId => (
                <div key={userId} className="table-row">
                  <span>{userId}</span>
                  <span>{latestReport.netPositions[userId].toFixed(2)}</span>
                  <span>{sumTokens(latestReport.lockCollected[userId] || blankTokenMap()).toFixed(2)}</span>
                  <span>{(latestReport.grossOutgoing[userId] || 0).toFixed(2)}</span>
                </div>
              ))}
            </div>

            <h3>4. Results</h3>
            <div className="table">
              <div className="table-row header">
                <span>User</span>
                <span>Net</span>
                {TOKENS.map(token => (
                  <span key={`result-header-${token.id}`}>{token.symbol}</span>
                ))}
              </div>
              {latestReport.participants.length === 0 && (
                <div className="table-row">
                  <span className="muted">No participants were eligible.</span>
                </div>
              )}
              {latestReport.participants.map(userId => {
                const perToken = latestReport.perTokenNet[userId] || blankTokenMap();
                return (
                  <div key={`result-${userId}`} className="table-row">
                    <span>{userId}</span>
                    <span>{sumTokens(perToken).toFixed(2)}</span>
                    {TOKENS.map(token => (
                      <span key={`${userId}-result-${token.id}`}>
                        {(perToken[token.id] || 0).toFixed(2)}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function FlowGraph({
  users,
  payments,
  swaps,
  dvps,
}: {
  users: User[];
  payments: Payment[];
  swaps: Swap[];
  dvps: DvP[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 380 });

  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const layout = useMemo(() => {
    const center = { x: size.width / 2, y: size.height / 2 };
    const radius = Math.max(120, Math.min(size.width, size.height) / 2 - 60);
    const nodes = users.map((user, idx) => {
      const angle = (idx / users.length) * Math.PI * 2 - Math.PI / 2;
      return {
        ...user,
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      };
    });
    return { center, nodes };
  }, [size, users]);

  const lookup = new Map(layout.nodes.map(node => [node.id, node]));

  const activePayments = payments.filter(p => p.status !== 'settled');
  const activeSwaps = swaps.filter(s => s.status !== 'settled');
  const activeDvps = dvps.filter(d => d.status !== 'settled');
  const dvpById = useMemo(() => new Map(dvps.map(dvp => [dvp.id, dvp])), [dvps]);

  return (
    <div ref={containerRef} className="graph-container">
      <svg width={size.width} height={size.height}>
        <circle
          cx={layout.center.x}
          cy={layout.center.y}
          r={30}
          fill="#e63946"
          stroke="#ffffff"
          strokeWidth={2}
        />
        <text x={layout.center.x} y={layout.center.y} textAnchor="middle" dy="4" fill="#fff" fontSize="10">
          CLEARING
        </text>

        {activePayments.map(payment => {
          const sender = lookup.get(payment.sender);
          const recipient = lookup.get(payment.recipient);
          if (!sender || !recipient) return null;
          const token = TOKENS.find(t => t.id === payment.token);
          const color = token?.color || '#8b949e';
          return (
            <g key={payment.id}>
              <line x1={sender.x} y1={sender.y} x2={layout.center.x} y2={layout.center.y} stroke={color} strokeWidth={2} />
              <line x1={recipient.x} y1={recipient.y} x2={layout.center.x} y2={layout.center.y} stroke={color} strokeWidth={2} strokeDasharray="4 4" />
            </g>
          );
        })}

        {activeSwaps.map(swap => {
          const maker = lookup.get(swap.maker);
          if (!maker) return null;
          const token = TOKENS.find(t => t.id === swap.sendToken);
          const color = token?.color || '#8b949e';
          return (
            <g key={swap.id}>
              <line x1={maker.x} y1={maker.y} x2={layout.center.x} y2={layout.center.y} stroke={color} strokeWidth={2} />
            </g>
          );
        })}

        {activeDvps.map(order => {
          const maker = lookup.get(order.maker);
          if (!maker) return null;
          const tokenId = resolveDvPPaymentToken(order, dvpById);
          const token = TOKENS.find(t => t.id === tokenId);
          const color = token?.color || '#8b949e';
          return (
            <g key={order.id}>
              <line x1={maker.x} y1={maker.y} x2={layout.center.x} y2={layout.center.y} stroke={color} strokeWidth={2} />
            </g>
          );
        })}

        {layout.nodes.map(node => (
          <g key={node.id}>
            <circle cx={node.x} cy={node.y} r={14} fill="#4cc9f0" stroke="#fff" strokeWidth={2} />
            <text x={node.x} y={node.y + 26} textAnchor="middle" fontSize="10" fill="#c9d1d9">
              {node.name}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

