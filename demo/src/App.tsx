import { useEffect, useState, useRef, useCallback } from 'react';
import { ethers } from 'ethers';
import config from './config.json';

// ============================================================================
// TYPES
// ============================================================================
interface Order {
  id: string;
  orderId: number;
  userId: string;
  type: 'BUY' | 'SELL';
  asset: string;
  assetAddress: string;
  tokenId: number;
  price: string;
  priceRaw: bigint;
  paymentToken: string;
  counterparty: string;
  color: string;
  status: 'pending' | 'matched' | 'clearing';
  createdAt: number;
  matchedWith?: string; // ID of matched order
}

interface LogEntry {
  time: string;
  msg: string;
  type: 'info' | 'success' | 'error' | 'match';
}

// ============================================================================
// CONSTANTS
// ============================================================================
const CENTER_RADIUS = 35;
const USER_RADIUS = 12;
const LAYOUT_RADIUS = 220;

const COLORS = {
  background: '#0d1117',
  center: '#e63946',
  centerGlow: 'rgba(230, 57, 70, 0.3)',
  user: '#4cc9f0',
  userGlow: 'rgba(76, 201, 240, 0.2)',
  buy: '#06d6a0',
  sell: '#ffd166',
  match: '#00ff00',
  text: '#e6edf3',
  textMuted: '#8b949e',
  panelBg: '#161b22',
  panelBorder: '#30363d',
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ordersRef = useRef<Order[]>([]);
  const animationRef = useRef<number>(0);
  const providerRef = useRef<any>(null); // RPC provider for tx/signing
  const wsProviderRef = useRef<any>(null); // WebSocket provider for events
  const contractsRef = useRef<any>({});

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAutoTraffic, setIsAutoTraffic] = useState(false);
  const autoTrafficRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [orderVersion, setOrderVersion] = useState(0); // Trigger re-renders when orders change
  const [debugVersion, setDebugVersion] = useState(0); // Force debug overlay refresh
  const [eventTransport, setEventTransport] = useState<'ws-open' | 'ws-closed' | 'polling' | 'none'>('none');
  const bumpOrdersVersion = useCallback(() => setOrderVersion(v => v + 1), []);
  const bumpDebug = useCallback(() => setDebugVersion(v => v + 1), []);

  // Debug refs
  const lastRenderRef = useRef<number>(0);
  const lastEventRef = useRef<string>('none yet');
  const eventCountersRef = useRef<{ placed: number; settled: number }>({ placed: 0, settled: 0 });
  const lastPolledBlockRef = useRef<number>(0);
  const seenOrderIdsRef = useRef<Set<string>>(new Set());
  const pollIntervalRef = useRef<any>(null);

  // --------------------------------------------------------------------------
  // LOGGING
  // --------------------------------------------------------------------------
  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [
      { time: new Date().toLocaleTimeString(), msg, type },
      ...prev
    ].slice(0, 50));
  }, []);

  // --------------------------------------------------------------------------
  // LAYOUT CALCULATION
  // --------------------------------------------------------------------------
  const getLayout = useCallback(() => {
    const graphWidth = dimensions.w - 440; // More space for order panel
    const graphHeight = dimensions.h;
    const centerX = graphWidth / 2;
    const centerY = graphHeight / 2;

    const users = config.users.map((addr, i) => {
      const angle = (i / config.users.length) * 2 * Math.PI - Math.PI / 2;
      return {
        id: addr.toLowerCase(), // Normalize for consistent comparison
        name: `User ${i + 1}`,
        shortAddr: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
        x: centerX + LAYOUT_RADIUS * Math.cos(angle),
        y: centerY + LAYOUT_RADIUS * Math.sin(angle),
      };
    });

    return { centerX, centerY, users, graphWidth, graphHeight };
  }, [dimensions]);

  // Resolve a user node position; if maker not in config.users, place deterministically
  const resolveUser = useCallback((users: Array<{ id: string; name: string; shortAddr: string; x: number; y: number }>, userId: string, centerX: number, centerY: number) => {
    const found = users.find(u => u.id === userId);
    if (found) return found;
    // Deterministic hash to position unknown addresses on the ring
    const addr = userId || '0x0';
    let hash = 0;
    for (let i = 0; i < addr.length; i++) {
      hash = (hash * 31 + addr.charCodeAt(i)) >>> 0;
    }
    const angle = (hash % 360) * (Math.PI / 180) - Math.PI / 2;
    const x = centerX + LAYOUT_RADIUS * Math.cos(angle);
    const y = centerY + LAYOUT_RADIUS * Math.sin(angle);
    return {
      id: userId,
      name: userId ? `${userId.slice(0, 6)}...${userId.slice(-4)}` : 'Unknown',
      shortAddr: userId ? `${userId.slice(0, 6)}...${userId.slice(-4)}` : 'Unknown',
      x,
      y,
    };
  }, []);

  // --------------------------------------------------------------------------
  // CANVAS RENDERING (Pure Canvas - No Library)
  // --------------------------------------------------------------------------
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { centerX, centerY, users, graphWidth, graphHeight } = getLayout();

    // Clear
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, graphWidth, graphHeight);

    const orders = ordersRef.current;
    
    // First pass: Draw match connection lines between matched orders
    const drawnMatchPairs = new Set<string>();
    for (const order of orders) {
      if (!order.matchedWith) continue;
      
      const pairKey = [order.id, order.matchedWith].sort().join('-');
      if (drawnMatchPairs.has(pairKey)) continue;
      drawnMatchPairs.add(pairKey);
      
      const matchedOrder = orders.find(o => o.id === order.matchedWith);
      if (!matchedOrder) continue;
      
      const user1 = users.find(u => u.id === order.userId);
      const user2 = users.find(u => u.id === matchedOrder.userId);
      if (!user1 || !user2) continue;
      
      // Draw curved match line through center
      ctx.beginPath();
      ctx.setLineDash([8, 4]);
      ctx.moveTo(user1.x, user1.y);
      ctx.quadraticCurveTo(centerX, centerY, user2.x, user2.y);
      ctx.strokeStyle = COLORS.match;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      
      // Draw "MATCH" label at center
      const matchLabelX = centerX;
      const matchLabelY = centerY - CENTER_RADIUS - 30;
      ctx.font = 'bold 14px Arial';
      ctx.fillStyle = COLORS.match;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('MATCH PENDING', matchLabelX, matchLabelY);
    }

    // Second pass: Draw Orders (Lines from user to clearing house)
    for (const order of orders) {
      const user = resolveUser(users, order.userId, centerX, centerY);

      const startX = user.x;
      const startY = user.y;
      const endX = centerX;
      const endY = centerY;

      // Determine line style based on status
      let lineColor = order.color;
      let lineWidth = 2;

      if (order.matchedWith && order.status === 'pending') {
        lineColor = COLORS.match;
        lineWidth = 3;
      } else if (order.status === 'matched') {
        lineColor = COLORS.match;
        lineWidth = 4;
      } else if (order.status === 'clearing') {
        lineColor = 'rgba(0, 255, 0, 0.3)';
        lineWidth = 5;
      }

      // Draw Line
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      // Draw Label (at midpoint)
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      
      // Offset labels to avoid overlap
      const angle = Math.atan2(endY - startY, endX - startX);
      const labelOffsetX = Math.sin(angle) * 20;
      const labelOffsetY = -Math.cos(angle) * 20;
      
      const labelText = order.status === 'matched' 
        ? 'SETTLED!' 
        : `#${order.orderId} ${order.type} @ ${order.price}`;

      ctx.font = 'bold 11px Arial';
      const textMetrics = ctx.measureText(labelText);
      const labelWidth = textMetrics.width + 12;
      const labelHeight = 20;

      // Label background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.fillRect(
        midX + labelOffsetX - labelWidth / 2, 
        midY + labelOffsetY - labelHeight / 2, 
        labelWidth, 
        labelHeight
      );
      ctx.strokeStyle = order.matchedWith ? COLORS.match : lineColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        midX + labelOffsetX - labelWidth / 2, 
        midY + labelOffsetY - labelHeight / 2, 
        labelWidth, 
        labelHeight
      );

      // Label text
      ctx.fillStyle = order.matchedWith ? COLORS.match : lineColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, midX + labelOffsetX, midY + labelOffsetY);
    }

    // Draw Users (outer nodes)
    for (const user of users) {
      // Count orders for this user
      const userOrders = orders.filter(o => o.userId === user.id);
      const hasPendingMatch = userOrders.some(o => o.matchedWith);
      
      // Glow (larger if has pending match)
      ctx.beginPath();
      ctx.arc(user.x, user.y, USER_RADIUS + (hasPendingMatch ? 10 : 6), 0, Math.PI * 2);
      ctx.fillStyle = hasPendingMatch ? 'rgba(0, 255, 0, 0.3)' : COLORS.userGlow;
      ctx.fill();

      // Node
      ctx.beginPath();
      ctx.arc(user.x, user.y, USER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = hasPendingMatch ? COLORS.match : COLORS.user;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      ctx.font = 'bold 12px Arial';
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(user.name, user.x, user.y + USER_RADIUS + 6);
      
      // Show order count if any
      if (userOrders.length > 0) {
        ctx.font = '10px Arial';
        ctx.fillStyle = COLORS.textMuted;
        ctx.fillText(`${userOrders.length} order${userOrders.length > 1 ? 's' : ''}`, user.x, user.y + USER_RADIUS + 20);
      }
    }

    // Draw Center (Clearing House)
    const hasPendingMatches = orders.some(o => o.matchedWith);
    
    // Glow
    ctx.beginPath();
    ctx.arc(centerX, centerY, CENTER_RADIUS + 12, 0, Math.PI * 2);
    ctx.fillStyle = hasPendingMatches ? 'rgba(0, 255, 0, 0.3)' : COLORS.centerGlow;
    ctx.fill();

    // Hexagon
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const x = centerX + CENTER_RADIUS * Math.cos(angle);
      const y = centerY + CENTER_RADIUS * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = hasPendingMatches ? '#238636' : COLORS.center;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Center Label
    ctx.font = 'bold 11px Arial';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CLEARING', centerX, centerY - 6);
    ctx.fillText('HOUSE', centerX, centerY + 6);
    
    // Order count
    if (orders.length > 0) {
      ctx.font = '10px Arial';
      ctx.fillText(`${orders.length} pending`, centerX, centerY + 22);
    }

    lastRenderRef.current = Date.now();
  }, [getLayout]);

  // --------------------------------------------------------------------------
  // ANIMATION LOOP (for UI updates)
  // --------------------------------------------------------------------------
  const lastOrderUpdateRef = useRef(0);
  const animate = useCallback(() => {
    const now = Date.now();

    render();
    
    // Update order version every 500ms to refresh the order panel
    if (now - lastOrderUpdateRef.current > 500) {
      lastOrderUpdateRef.current = now;
      setOrderVersion(v => v + 1);
    }
    
    animationRef.current = requestAnimationFrame(animate);
  }, [render]);

  // --------------------------------------------------------------------------
  // START/STOP ANIMATION
  // --------------------------------------------------------------------------
  useEffect(() => {
    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [animate]);

  // --------------------------------------------------------------------------
  // RESIZE HANDLING
  // --------------------------------------------------------------------------
  useEffect(() => {
    const handleResize = () => setDimensions({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // --------------------------------------------------------------------------
  // BLOCKCHAIN CONNECTION
  // --------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      try {
        // RPC provider for tx + signer
        const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
        providerRef.current = provider;
        provider.pollingInterval = 1500;
        const signer = await provider.getSigner();

        // Try WebSocket provider for events; fallback to polling if unavailable
        let chEventsProvider: any = provider;
        try {
          const wsProvider = new ethers.WebSocketProvider("ws://127.0.0.1:8545");
          // Simple readiness check with timeout; ethers v6 exposes .websocket
          await (wsProvider.websocket?.readyState === 1
            ? Promise.resolve()
            : new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('ws timeout')), 1000);
                if (wsProvider.websocket) {
                  wsProvider.websocket.onopen = () => {
                    clearTimeout(timer);
                    resolve(null);
                  };
                  wsProvider.websocket.onerror = (e: any) => {
                    clearTimeout(timer);
                    reject(e);
                  };
                } else {
                  clearTimeout(timer);
                  reject(new Error('ws not available'));
                }
              }));
          chEventsProvider = wsProvider;
          wsProviderRef.current = wsProvider;
          setEventTransport('ws-open');
          bumpDebug();
        } catch (e) {
          console.warn('WebSocket unavailable, using polling for events', e);
          wsProviderRef.current = null;
          setEventTransport('polling');
          bumpDebug();
        }

        const ch = new ethers.Contract(
          config.addresses.ClearingHouse,
          config.abis.ClearingHouse,
          signer
        );
        const chEvents = new ethers.Contract(
          config.addresses.ClearingHouse,
          config.abis.ClearingHouse,
          chEventsProvider
        );
        contractsRef.current.ClearingHouse = ch;
        contractsRef.current.ClearingHouseEvents = chEvents;

        // Order Placed Event (via WebSocket provider)
        chEvents.on("OrderPlaced", (id, maker, asset, tokenId, side, price, counterparty) => {
          console.debug('[OrderPlaced ws]', { id: id.toString(), maker, asset, tokenId: tokenId.toString(), side: side.toString(), price: price.toString() });
          const orderType = side.toString() === "0" ? "BUY" : "SELL";
          const priceFmt = parseFloat(ethers.formatUnits(price, 18)).toFixed(2);
          const assetName = `Asset #${tokenId}`;
          // Normalize addresses for consistent comparison
          const normalizedMaker = maker.toLowerCase();

          addLog(`Order #${id}: ${maker.slice(0, 6)}... ${orderType} ${assetName} @ ${priceFmt}`, 'info');

          const newOrder: Order = {
            id: `order-${id}`,
            orderId: Number(id),
            userId: normalizedMaker,
            type: orderType as 'BUY' | 'SELL',
            asset: assetName,
            assetAddress: asset.toLowerCase(),
            tokenId: Number(tokenId),
            price: priceFmt,
            priceRaw: BigInt(price.toString()),
            paymentToken: config.addresses.TokenA.toLowerCase(),
            counterparty: counterparty ? counterparty.toLowerCase() : '',
            color: orderType === 'BUY' ? COLORS.buy : COLORS.sell,
            status: 'pending',
            createdAt: Date.now(),
          };

          ordersRef.current = [...ordersRef.current, newOrder];
          bumpOrdersVersion();
          eventCountersRef.current.placed += 1;
          lastEventRef.current = `OrderPlaced #${id}`;
          bumpDebug();
          
          // Check for potential matches immediately
          checkForMatches(newOrder);
        });

        // Settlement Event (via WebSocket provider)
        chEvents.on("SettlementCompleted", async () => {
          console.debug('[SettlementCompleted ws]');
          addLog('Settlement cycle executed!', 'success');
          await checkMatches();
          eventCountersRef.current.settled += 1;
          lastEventRef.current = 'SettlementCompleted';
          bumpDebug();
          bumpOrdersVersion();
        });

        addLog('Connected to blockchain.', 'success');
      } catch (err) {
        console.error(err);
        addLog('Failed to connect to blockchain.', 'error');
      }
    };

    init();

    return () => {
      contractsRef.current.ClearingHouse?.removeAllListeners();
      contractsRef.current.ClearingHouseEvents?.removeAllListeners();
      stopAutoTraffic();
      try { wsProviderRef.current?.destroy?.(); } catch {}
    };
  }, [addLog]);

 

  // --------------------------------------------------------------------------
  // CHECK FOR POTENTIAL MATCHES (client-side preview)
  // --------------------------------------------------------------------------
  const checkForMatches = useCallback((newOrder: Order) => {
    const orders = ordersRef.current;
    
    // Find potential matching order (opposite side, same asset, overlapping price)
    for (const existingOrder of orders) {
      if (existingOrder.id === newOrder.id) continue;
      if (existingOrder.status !== 'pending') continue;
      if (existingOrder.assetAddress !== newOrder.assetAddress) continue;
      if (existingOrder.tokenId !== newOrder.tokenId) continue;
      if (existingOrder.type === newOrder.type) continue; // Must be opposite sides
      
      // Check price compatibility (buy price >= sell price for a match)
      const buyOrder = newOrder.type === 'BUY' ? newOrder : existingOrder;
      const sellOrder = newOrder.type === 'SELL' ? newOrder : existingOrder;
      
      if (buyOrder.priceRaw >= sellOrder.priceRaw) {
        addLog(`Potential match found: Order #${buyOrder.orderId} <-> Order #${sellOrder.orderId}`, 'match');
        
        // Mark both as potentially matched (visual indicator)
        ordersRef.current = ordersRef.current.map(o => {
          if (o.id === buyOrder.id) return { ...o, matchedWith: sellOrder.id };
          if (o.id === sellOrder.id) return { ...o, matchedWith: buyOrder.id };
          return o;
        });
        bumpOrdersVersion();
        break;
      }
    }
  }, [addLog]);

  // --------------------------------------------------------------------------
  // CHECK MATCHES (on-chain settlement verification)
  // --------------------------------------------------------------------------
  const checkMatches = async () => {
    const ch = contractsRef.current.ClearingHouse;
    if (!ch) return;

    const orders = ordersRef.current;
    const matchedIds: string[] = [];

    for (const order of orders) {
      try {
        const onChainOrder = await ch.orders(order.orderId);
        if (!onChainOrder.active) {
          matchedIds.push(order.id);
        }
      } catch (e) {
        console.error(e);
      }
    }

    if (matchedIds.length > 0) {
      addLog(`${matchedIds.length} orders settled on-chain!`, 'match');

      // Phase 1: Mark as matched (bright green, fast particles)
      ordersRef.current = ordersRef.current.map(o =>
        matchedIds.includes(o.id) ? { ...o, status: 'matched' as const, createdAt: Date.now() } : o
      );
      bumpOrdersVersion();

      // Phase 2: Mark as clearing (fade out)
      setTimeout(() => {
        ordersRef.current = ordersRef.current.map(o =>
          matchedIds.includes(o.id) ? { ...o, status: 'clearing' as const } : o
        );
        bumpOrdersVersion();
      }, 2500);

      // Phase 3: Remove
      setTimeout(() => {
        ordersRef.current = ordersRef.current.filter(o => !matchedIds.includes(o.id));
        addLog('Settled orders cleared from view.', 'info');
        bumpOrdersVersion();
      }, 3500);
    }
  };

  // --------------------------------------------------------------------------
  // POLLING FALLBACK FOR EVENTS
  // --------------------------------------------------------------------------
  useEffect(() => {
    // Always run a lightweight poller as a safety net (deduped by seenOrderIdsRef)
    const provider = providerRef.current;
    const chAddr = config.addresses.ClearingHouse.toLowerCase();
    if (!provider || !contractsRef.current.ClearingHouse) return;

    const iface = new ethers.Interface(config.abis.ClearingHouse);

    const ensureStartBlock = async () => {
      if (lastPolledBlockRef.current === 0) {
        lastPolledBlockRef.current = await provider.getBlockNumber();
      }
    };

    const handleOrderPlaced = (id: bigint, maker: string, asset: string, tokenId: bigint, side: bigint, price: bigint, counterparty: string) => {
      const orderIdStr = id.toString();
      if (seenOrderIdsRef.current.has(orderIdStr)) return;
      seenOrderIdsRef.current.add(orderIdStr);

      const orderType = side.toString() === "0" ? "BUY" : "SELL";
      const priceFmt = parseFloat(ethers.formatUnits(price, 18)).toFixed(2);
      const assetName = `Asset #${tokenId}`;
      const normalizedMaker = maker.toLowerCase();

      addLog(`(poll) Order #${id}: ${maker.slice(0, 6)}... ${orderType} ${assetName} @ ${priceFmt}`, 'info');

      const newOrder: Order = {
        id: `order-${id}`,
        orderId: Number(id),
        userId: normalizedMaker,
        type: orderType as 'BUY' | 'SELL',
        asset: assetName,
        assetAddress: asset.toLowerCase(),
        tokenId: Number(tokenId),
        price: priceFmt,
        priceRaw: BigInt(price.toString()),
        paymentToken: config.addresses.TokenA.toLowerCase(),
        counterparty: counterparty ? counterparty.toLowerCase() : '',
        color: orderType === 'BUY' ? COLORS.buy : COLORS.sell,
        status: 'pending',
        createdAt: Date.now(),
      };

      ordersRef.current = [...ordersRef.current, newOrder];
      bumpOrdersVersion();
      eventCountersRef.current.placed += 1;
      lastEventRef.current = `(poll) OrderPlaced #${id}`;
      bumpDebug();

      checkForMatches(newOrder);
    };

    const pollLogs = async () => {
      try {
        await ensureStartBlock();
        const latest = await provider.getBlockNumber();
        const from = lastPolledBlockRef.current + 1;
        if (from > latest) return;

        const logs = await provider.getLogs({
          address: chAddr,
          fromBlock: from,
          toBlock: latest,
        });

        for (const log of logs) {
          try {
            const parsed = iface.parseLog(log);
            if (!parsed) continue;
            if (parsed.name === 'OrderPlaced') {
              const [id, maker, asset, tokenId, side, price, counterparty] = parsed.args;
              handleOrderPlaced(id, maker, asset, tokenId, side, price, counterparty);
            } else if (parsed.name === 'SettlementCompleted') {
              addLog('(poll) Settlement cycle executed!', 'success');
              eventCountersRef.current.settled += 1;
              lastEventRef.current = '(poll) SettlementCompleted';
              bumpDebug();
              await checkMatches();
            }
          } catch (err) {
            console.warn('Failed to parse log', err);
          }
        }

        lastPolledBlockRef.current = latest;
      } catch (err) {
        console.warn('Polling error', err);
      }
    };

    // Immediate poll and start interval
    pollLogs();
    pollIntervalRef.current = setInterval(pollLogs, 2000);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    };
  }, [eventTransport, addLog, checkForMatches, bumpDebug, bumpOrdersVersion]);

  // --------------------------------------------------------------------------
  // TRAFFIC SIMULATION
  // --------------------------------------------------------------------------
  const simulateTraffic = async () => {
    if (!contractsRef.current.ClearingHouse) {
      console.error('[simulateTraffic] No ClearingHouse contract');
      addLog('No contract available', 'error');
      return;
    }

    const provider = providerRef.current;
    const userIndex = Math.floor(Math.random() * config.users.length);
    const userAddress = config.users[userIndex];
    
    console.log('[simulateTraffic] Getting signer for', userAddress);
    const signer = await provider.getSigner(userAddress);
    const chWithSigner = contractsRef.current.ClearingHouse.connect(signer);

    const isBuy = Math.random() > 0.5;
    const price = ethers.parseUnits((10 + Math.floor(Math.random() * 50)).toString(), 18);
    const assetId = 1 + Math.floor(Math.random() * 3);

    console.log('[simulateTraffic] Submitting', isBuy ? 'BUY' : 'SELL', 'order, asset:', assetId, 'price:', price.toString());
    addLog(`Submitting ${isBuy ? 'BUY' : 'SELL'} order...`, 'info');

    try {
      let tx;
      if (isBuy) {
        tx = await chWithSigner.submitBuyOrder(
          config.addresses.Bond,
          assetId,
          config.addresses.TokenA,
          price,
          ethers.ZeroAddress
        );
      } else {
        tx = await chWithSigner.submitMulticurrencySellOrder(
          config.addresses.Bond,
          assetId,
          [config.addresses.TokenA],
          [price],
          ethers.ZeroAddress
        );
      }
      console.log('[simulateTraffic] TX sent:', tx.hash);
      addLog(`TX sent: ${tx.hash.slice(0, 10)}...`, 'info');
      const receipt = await tx.wait();
      console.log('[simulateTraffic] TX mined, block:', receipt.blockNumber, 'status:', receipt.status, 'logs:', receipt.logs.length);
      
      if (receipt.status === 0) {
        console.error('[simulateTraffic] TX REVERTED!');
        addLog(`TX REVERTED in block ${receipt.blockNumber}`, 'error');
      } else if (receipt.logs.length === 0) {
        console.warn('[simulateTraffic] TX succeeded but no logs emitted - checking contract state...');
        addLog(`TX mined but no events (possible revert)`, 'error');
        
        // Try to read nextOrderId to verify contract is working
        try {
          const nextId = await contractsRef.current.ClearingHouse.nextOrderId();
          console.log('[simulateTraffic] Contract nextOrderId:', nextId.toString());
          addLog(`Contract nextOrderId: ${nextId.toString()}`, 'info');
        } catch (e) {
          console.error('[simulateTraffic] Failed to read nextOrderId:', e);
        }
      } else {
        addLog(`TX mined in block ${receipt.blockNumber} with ${receipt.logs.length} logs`, 'success');
      }
    } catch (e: any) {
      console.error('[simulateTraffic] Error:', e);
      addLog(`Order failed: ${e.message?.slice(0, 50) || 'unknown error'}`, 'error');
    }
  };

  const toggleAutoTraffic = () => {
    if (isAutoTraffic) {
      stopAutoTraffic();
      addLog('Auto-traffic stopped.', 'info');
    } else {
      setIsAutoTraffic(true);
      addLog('Auto-traffic started.', 'info');
      simulateTraffic();
      autoTrafficRef.current = setInterval(simulateTraffic, 2000);
    }
  };

  const stopAutoTraffic = () => {
    if (autoTrafficRef.current) clearInterval(autoTrafficRef.current);
    autoTrafficRef.current = null;
    setIsAutoTraffic(false);
  };

  // Test contract connection
  const testContract = async () => {
    try {
      const ch = contractsRef.current.ClearingHouse;
      if (!ch) {
        addLog('No contract instance', 'error');
        return;
      }
      
      console.log('[testContract] Contract address:', await ch.getAddress());
      addLog(`Contract: ${config.addresses.ClearingHouse}`, 'info');
      
      const nextOrderId = await ch.nextOrderId();
      console.log('[testContract] nextOrderId:', nextOrderId.toString());
      addLog(`nextOrderId: ${nextOrderId.toString()}`, 'info');
      
      const settlementInterval = await ch.SETTLEMENT_INTERVAL();
      console.log('[testContract] SETTLEMENT_INTERVAL:', settlementInterval.toString());
      addLog(`SETTLEMENT_INTERVAL: ${settlementInterval.toString()}s`, 'info');
      
      const lastSettlement = await ch.lastSettlementTime();
      console.log('[testContract] lastSettlementTime:', lastSettlement.toString());
      addLog(`lastSettlementTime: ${lastSettlement.toString()}`, 'info');
      
      // Try to get code at address
      const provider = providerRef.current;
      const code = await provider.getCode(config.addresses.ClearingHouse);
      console.log('[testContract] Contract code length:', code.length);
      addLog(`Contract code: ${code.length > 10 ? 'deployed (' + code.length + ' bytes)' : 'NO CODE!'}`, code.length > 10 ? 'success' : 'error');
      
    } catch (err: any) {
      console.error('[testContract] Error:', err);
      addLog(`Test failed: ${err.message?.slice(0, 50) || 'unknown'}`, 'error');
    }
  };

  // Manually fetch all past events from block 0
  const fetchPastEvents = async () => {
    try {
      const provider = providerRef.current;
      if (!provider) {
        addLog('No provider available', 'error');
        return;
      }
      const chAddr = config.addresses.ClearingHouse;
      const iface = new ethers.Interface(config.abis.ClearingHouse);
      
      const latest = await provider.getBlockNumber();
      console.log('[fetchPastEvents] Fetching logs from block 0 to', latest, 'for contract', chAddr);
      addLog(`Fetching events from block 0 to ${latest}...`, 'info');
      
      const logs = await provider.getLogs({
        address: chAddr,
        fromBlock: 0,
        toBlock: latest,
      });
      
      console.log('[fetchPastEvents] Found', logs.length, 'logs');
      addLog(`Found ${logs.length} total logs`, logs.length > 0 ? 'success' : 'info');
      
      let orderCount = 0;
      for (const log of logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === 'OrderPlaced') {
            orderCount++;
            const [id, maker, asset, tokenId, side, price, counterparty] = parsed.args;
            console.log('[fetchPastEvents] OrderPlaced:', { id: id.toString(), maker, side: side.toString() });
            
            // Add to orders if not already present
            const orderId = `order-${id}`;
            if (!ordersRef.current.find(o => o.id === orderId)) {
              const orderType = side.toString() === "0" ? "BUY" : "SELL";
              const priceFmt = parseFloat(ethers.formatUnits(price, 18)).toFixed(2);
              const newOrder: Order = {
                id: orderId,
                orderId: Number(id),
                userId: maker.toLowerCase(),
                type: orderType as 'BUY' | 'SELL',
                asset: `Asset #${tokenId}`,
                assetAddress: asset.toLowerCase(),
                tokenId: Number(tokenId),
                price: priceFmt,
                priceRaw: BigInt(price.toString()),
                paymentToken: config.addresses.TokenA.toLowerCase(),
                counterparty: counterparty ? counterparty.toLowerCase() : '',
                color: orderType === 'BUY' ? COLORS.buy : COLORS.sell,
                status: 'pending',
                createdAt: Date.now(),
              };
              ordersRef.current = [...ordersRef.current, newOrder];
            }
          }
        } catch (err) {
          console.warn('[fetchPastEvents] Failed to parse log', err);
        }
      }
      
      addLog(`Found ${orderCount} OrderPlaced events`, orderCount > 0 ? 'match' : 'info');
      eventCountersRef.current.placed = orderCount;
      bumpOrdersVersion();
      bumpDebug();
    } catch (err: any) {
      console.error('[fetchPastEvents] Error:', err);
      addLog(`Fetch failed: ${err.message?.slice(0, 50) || 'unknown'}`, 'error');
    }
  };

  const triggerSettlement = async () => {
    try {
      await providerRef.current.send("evm_increaseTime", [301]);
      await providerRef.current.send("evm_mine", []);
      const tx = await contractsRef.current.ClearingHouse.performSettlement();
      addLog('Settlement initiated...', 'info');
      await tx.wait();
    } catch (e) {
      console.error(e);
      addLog('Settlement failed.', 'error');
    }
  };

  // --------------------------------------------------------------------------
  // RENDER UI
  // --------------------------------------------------------------------------
  const graphWidth = dimensions.w - 440; // Left sidebar + right panel
  const graphHeight = dimensions.h;
  // orderVersion is used to trigger re-renders when orders change
  void orderVersion;
  void debugVersion;
  const currentOrders = [...ordersRef.current]; // Snapshot for rendering

  return (
    <div style={{ display: 'flex', height: '100vh', background: COLORS.background, color: COLORS.text, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      
      {/* Left Sidebar - Controls */}
      <div style={{
        width: 260,
        padding: 20,
        background: COLORS.panelBg,
        borderRight: `1px solid ${COLORS.panelBorder}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        overflowY: 'auto',
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: '#58a6ff' }}>ClearingHouse</h1>
          <p style={{ margin: '6px 0 0', color: COLORS.textMuted, fontSize: 13 }}>
            Real-time Settlement Visualization
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button onClick={simulateTraffic}>Create Single Order</Button>
          <Button 
            onClick={toggleAutoTraffic} 
            style={{ background: isAutoTraffic ? '#da3633' : '#1f6feb' }}
          >
            {isAutoTraffic ? 'Stop Auto-Traffic' : 'Start Auto-Traffic'}
          </Button>
          <Button onClick={triggerSettlement} style={{ background: '#238636' }}>
            Trigger Settlement
          </Button>
          <Button onClick={fetchPastEvents} style={{ background: '#6e40c9' }}>
            Fetch Past Events
          </Button>
          <Button onClick={testContract} style={{ background: '#f78166' }}>
            Test Contract
          </Button>
        </div>

        <div style={{ background: COLORS.background, padding: 14, borderRadius: 8, border: `1px solid ${COLORS.panelBorder}` }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>Legend</h3>
          <LegendItem color={COLORS.center} label="Clearing House" />
          <LegendItem color={COLORS.user} label="Participant" />
          <LegendItem color={COLORS.buy} label="Buy Order" isLine />
          <LegendItem color={COLORS.sell} label="Sell Order" isLine />
          <LegendItem color={COLORS.match} label="Matched" isLine />
        </div>

        {/* Activity Log */}
        <div style={{ flex: 1, minHeight: 150 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 13 }}>Activity Log</h3>
          <div style={{
            background: COLORS.background,
            border: `1px solid ${COLORS.panelBorder}`,
            borderRadius: 8,
            padding: 10,
            maxHeight: 250,
            overflowY: 'auto',
          }}>
            {logs.length === 0 && (
              <div style={{ color: COLORS.textMuted, fontSize: 12 }}>No activity yet...</div>
            )}
            {logs.map((log, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  padding: '5px 0',
                  borderBottom: i < logs.length - 1 ? `1px solid ${COLORS.panelBorder}` : 'none',
                  color: log.type === 'match' ? COLORS.match : log.type === 'error' ? '#f85149' : COLORS.text,
                }}
              >
                <span style={{ color: COLORS.textMuted, marginRight: 6 }}>[{log.time}]</span>
                {log.msg}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={graphWidth}
        height={graphHeight}
        style={{ display: 'block', flex: 1 }}
      />

      {/* Right Panel - Order Book */}
      <div style={{
        width: 180,
        padding: 16,
        background: COLORS.panelBg,
        borderLeft: `1px solid ${COLORS.panelBorder}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        overflowY: 'auto',
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, color: '#58a6ff' }}>Order Book</h2>
          <p style={{ margin: '4px 0 0', color: COLORS.textMuted, fontSize: 12 }}>
            {currentOrders.length} active order{currentOrders.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Buy Orders */}
        <div>
          <h3 style={{ margin: '0 0 8px', fontSize: 12, color: COLORS.buy, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, background: COLORS.buy, borderRadius: 2 }} />
            BUY ORDERS
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {currentOrders.filter(o => o.type === 'BUY' && o.status === 'pending').length === 0 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted, fontStyle: 'italic' }}>No buy orders</div>
            ) : (
              currentOrders.filter(o => o.type === 'BUY' && o.status === 'pending').map(order => (
                <OrderCard key={order.id} order={order} />
              ))
            )}
          </div>
        </div>

        {/* Sell Orders */}
        <div>
          <h3 style={{ margin: '0 0 8px', fontSize: 12, color: COLORS.sell, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, background: COLORS.sell, borderRadius: 2 }} />
            SELL ORDERS
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {currentOrders.filter(o => o.type === 'SELL' && o.status === 'pending').length === 0 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted, fontStyle: 'italic' }}>No sell orders</div>
            ) : (
              currentOrders.filter(o => o.type === 'SELL' && o.status === 'pending').map(order => (
                <OrderCard key={order.id} order={order} />
              ))
            )}
          </div>
        </div>

        {/* Matched Orders */}
        {currentOrders.filter(o => o.matchedWith || o.status === 'matched').length > 0 && (
          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: 12, color: COLORS.match, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, background: COLORS.match, borderRadius: 2 }} />
              MATCHES
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {currentOrders.filter(o => o.matchedWith || o.status === 'matched').map(order => (
                <OrderCard key={order.id} order={order} isMatch />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Debug Overlay */}
      <div
        style={{
          position: 'fixed',
          right: 12,
          bottom: 12,
          background: '#0b0f16',
          border: `1px solid ${COLORS.panelBorder}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 11,
          color: COLORS.textMuted,
          width: 220,
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
          opacity: 0.9,
        }}
      >
        <div style={{ color: '#58a6ff', fontWeight: 700, marginBottom: 6 }}>Debug</div>
        <div>Orders in memory: <span style={{ color: '#fff' }}>{ordersRef.current.length}</span></div>
        <div>Last event: <span style={{ color: '#fff' }}>{lastEventRef.current}</span></div>
        <div>Events — placed: <span style={{ color: '#fff' }}>{eventCountersRef.current.placed}</span> / settled: <span style={{ color: '#fff' }}>{eventCountersRef.current.settled}</span></div>
        <div>Last render: <span style={{ color: '#fff' }}>{lastRenderRef.current ? `${((Date.now() - lastRenderRef.current) / 1000).toFixed(1)}s ago` : 'n/a'}</span></div>
        <div>Events via: <span style={{ color: eventTransport === 'ws-open' ? '#00ff7f' : eventTransport === 'polling' ? '#ffd166' : '#f85149' }}>{eventTransport}</span></div>
        <div style={{ marginTop: 6, color: '#9e6eff' }}>Users mapped: <span style={{ color: '#fff' }}>{config.users.length}</span></div>
        <div style={{ maxHeight: 120, overflow: 'auto', marginTop: 6 }}>
          <div style={{ color: COLORS.textMuted, marginBottom: 4 }}>Recent orders:</div>
          {ordersRef.current.slice(-5).reverse().map(o => (
            <div key={o.id} style={{ color: '#fff' }}>
              #{o.orderId} {o.type} {o.price} {o.userId.slice(0,6)}...
            </div>
          ))}
          {ordersRef.current.length === 0 && (
            <div style={{ color: '#666' }}>none</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================
function Button({ children, onClick, style = {} }: { children: React.ReactNode; onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '12px 16px',
        fontSize: 14,
        fontWeight: 600,
        border: 'none',
        borderRadius: 6,
        background: '#21262d',
        color: '#e6edf3',
        cursor: 'pointer',
        transition: 'opacity 0.2s',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function LegendItem({ color, label, isLine = false }: { color: string; label: string; isLine?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, fontSize: 12 }}>
      <span
        style={{
          width: isLine ? 20 : 10,
          height: isLine ? 3 : 10,
          background: color,
          borderRadius: isLine ? 2 : 5,
          marginRight: 8,
        }}
      />
      {label}
    </div>
  );
}

function OrderCard({ order, isMatch = false }: { order: Order; isMatch?: boolean }) {
  const borderColor = isMatch ? COLORS.match : (order.type === 'BUY' ? COLORS.buy : COLORS.sell);
  const age = Math.floor((Date.now() - order.createdAt) / 1000);
  
  return (
    <div style={{
      background: COLORS.background,
      border: `1px solid ${borderColor}`,
      borderRadius: 6,
      padding: 8,
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontWeight: 600, color: borderColor }}>#{order.orderId}</span>
        <span style={{ 
          fontSize: 9, 
          padding: '2px 4px', 
          background: borderColor, 
          color: '#000', 
          borderRadius: 3,
          fontWeight: 600,
        }}>
          {order.type}
        </span>
      </div>
      <div style={{ color: COLORS.text, marginBottom: 2 }}>
        {order.asset}
      </div>
      <div style={{ color: COLORS.textMuted, display: 'flex', justifyContent: 'space-between' }}>
        <span>@ {order.price}</span>
        <span>{age}s ago</span>
      </div>
      {order.matchedWith && (
        <div style={{ 
          marginTop: 4, 
          paddingTop: 4, 
          borderTop: `1px dashed ${COLORS.panelBorder}`,
          color: COLORS.match,
          fontSize: 10,
        }}>
          ↔ Matched with #{order.matchedWith.replace('order-', '')}
        </div>
      )}
    </div>
  );
}
