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

interface PaymentRequest {
  id: string;
  paymentId: number;
  recipient: string;
  sender: string;
  amount: string;
  amountRaw: bigint;
  status: 'pending' | 'fulfilled' | 'settled' | 'cancelled';
  createdAt: number;
  fulfilledToken?: string;
}

interface SwapOrder {
  id: string;
  orderId: number;
  maker: string;
  sendAmount: string;
  sendAmountRaw: bigint;
  sendToken: string;
  receiveAmount: string;
  receiveAmountRaw: bigint;
  status: 'pending' | 'matched' | 'settled';
  createdAt: number;
  matchedOrderId?: number;
}


interface LogEntry {
  time: string;
  msg: string;
  type: 'info' | 'success' | 'error' | 'match' | 'payment' | 'swap';
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
  const paymentsRef = useRef<PaymentRequest[]>([]);
  const swapsRef = useRef<SwapOrder[]>([]);
  const animationRef = useRef<number>(0);
  const providerRef = useRef<any>(null);
  const contractsRef = useRef<any>({});

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isAutoTraffic, setIsAutoTraffic] = useState(false);
  const autoTrafficRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [orderVersion, setOrderVersion] = useState(0);
  const [paymentVersion, setPaymentVersion] = useState(0);
  const [swapVersion, setSwapVersion] = useState(0);
  const [eventTransport, setEventTransport] = useState<'ws-open' | 'ws-closed' | 'polling' | 'none'>('none');
  const [activeTab, setActiveTab] = useState<'dvp' | 'payments' | 'swaps'>('dvp');
  const bumpOrdersVersion = useCallback(() => setOrderVersion(v => v + 1), []);
  const bumpPaymentsVersion = useCallback(() => setPaymentVersion(v => v + 1), []);
  const bumpSwapsVersion = useCallback(() => setSwapVersion(v => v + 1), []);

  const lastPolledBlockRef = useRef<number>(0);
  const seenOrderIdsRef = useRef<Set<string>>(new Set());
  const seenPaymentIdsRef = useRef<Set<string>>(new Set());
  const seenSwapIdsRef = useRef<Set<string>>(new Set());
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
    const centerY = (graphHeight / 2) - 80; // Move network up to make room for bottom panel

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

  // Helper: Draw rounded rectangle
  const drawRoundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { centerX, centerY, users, graphWidth, graphHeight } = getLayout();

    // Clear with subtle gradient background
    const bgGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, graphWidth / 2);
    bgGradient.addColorStop(0, '#151b23');
    bgGradient.addColorStop(1, COLORS.background);
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, graphWidth, graphHeight);

    // Draw subtle grid pattern
    ctx.strokeStyle = 'rgba(48, 54, 61, 0.3)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = gridSize; x < graphWidth; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, graphHeight);
      ctx.stroke();
    }
    for (let y = gridSize; y < graphHeight; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(graphWidth, y);
      ctx.stroke();
    }

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
      
      // Draw glow for match line
      ctx.save();
      ctx.shadowColor = COLORS.match;
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.setLineDash([8, 4]);
      ctx.moveTo(user1.x, user1.y);
      ctx.quadraticCurveTo(centerX, centerY, user2.x, user2.y);
      ctx.strokeStyle = COLORS.match;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Second pass: Draw Orders, Payments, and Swaps
    const drawTransaction = (startX: number, startY: number, endX: number, endY: number, color: string, label: string, status: string, id: number, matched?: boolean) => {
      // Determine line style based on status
      let lineColor = color;
      let lineWidth = 2;
      let glowColor = color;

      if (matched && status === 'pending') {
        lineColor = COLORS.match;
        glowColor = COLORS.match;
        lineWidth = 3;
      } else if (status === 'matched' || status === 'fulfilled') {
        lineColor = COLORS.match;
        glowColor = COLORS.match;
        lineWidth = 4;
      } else if (status === 'settled' || status === 'clearing') {
        lineColor = 'rgba(0, 255, 0, 0.3)';
        glowColor = COLORS.match;
        lineWidth = 5;
      }

      // Draw line with subtle glow
      ctx.save();
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();

      // Draw Label (at midpoint)
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;

      // Offset labels to avoid overlap
      const angle = Math.atan2(endY - startY, endX - startX);
      const labelOffsetX = Math.sin(angle) * 25;
      const labelOffsetY = -Math.cos(angle) * 25;

      const labelText = (status === 'matched' || status === 'settled')
        ? '✓ SETTLED'
        : `${label} #${id}`;

      ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const textMetrics = ctx.measureText(labelText);
      const labelWidth = textMetrics.width + 14;
      const labelHeight = 22;
      const labelX = midX + labelOffsetX - labelWidth / 2;
      const labelY = midY + labelOffsetY - labelHeight / 2;

      // Label background with rounded corners
      const labelBorderColor = matched ? COLORS.match : lineColor;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      drawRoundedRect(ctx, labelX, labelY, labelWidth, labelHeight, 4);
      ctx.fillStyle = 'rgba(22, 27, 34, 0.95)';
      ctx.fill();
      ctx.strokeStyle = labelBorderColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      // Label text
      ctx.fillStyle = labelBorderColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelText, midX + labelOffsetX, midY + labelOffsetY);
    };

    // Draw DvP Orders
    for (const order of orders) {
      const user = resolveUser(users, order.userId, centerX, centerY);
      drawTransaction(
        user.x, user.y, centerX, centerY,
        order.color,
        `${order.type} ${order.price}`,
        order.status,
        order.orderId,
        !!order.matchedWith
      );
    }

    // Draw Payment Requests
    for (const payment of currentPayments) {
      const senderUser = resolveUser(users, payment.sender, centerX, centerY);
      const recipientUser = resolveUser(users, payment.recipient, centerX, centerY);

      // Draw from sender to recipient, then to clearing house
      const color = payment.status === 'fulfilled' ? '#0088ff' : '#00ff88';

      if (payment.sender !== ethers.ZeroAddress) {
        // Draw from sender to clearing house
        drawTransaction(
          senderUser.x, senderUser.y, centerX, centerY,
          color,
          `PAY ${payment.amount}`,
          payment.status,
          payment.paymentId,
          false
        );
      } else {
        // Open payment request - just to clearing house
        drawTransaction(
          recipientUser.x, recipientUser.y, centerX, centerY,
          color,
          `REQ ${payment.amount}`,
          payment.status,
          payment.paymentId,
          false
        );
      }
    }

    // Draw Swap Orders
    for (const swap of currentSwaps) {
      const makerUser = resolveUser(users, swap.maker, centerX, centerY);
      const color = swap.matchedOrderId ? COLORS.match : '#ff8800';

      drawTransaction(
        makerUser.x, makerUser.y, centerX, centerY,
        color,
        `SWAP ${swap.sendAmount}`,
        swap.status,
        swap.orderId,
        !!swap.matchedOrderId
      );
    }

    // Draw Users (outer nodes)
    for (const user of users) {
      const userOrders = orders.filter(o => o.userId === user.id);
      const hasPendingMatch = userOrders.some(o => o.matchedWith);
      const hasOrders = userOrders.length > 0;
      
      // Outer glow
      if (hasPendingMatch || hasOrders) {
        const glowGradient = ctx.createRadialGradient(user.x, user.y, USER_RADIUS, user.x, user.y, USER_RADIUS + (hasPendingMatch ? 18 : 12));
        glowGradient.addColorStop(0, hasPendingMatch ? 'rgba(0, 255, 0, 0.4)' : 'rgba(76, 201, 240, 0.3)');
        glowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(user.x, user.y, USER_RADIUS + (hasPendingMatch ? 18 : 12), 0, Math.PI * 2);
        ctx.fillStyle = glowGradient;
        ctx.fill();
      }

      // Node with gradient
      const nodeGradient = ctx.createRadialGradient(user.x - 3, user.y - 3, 0, user.x, user.y, USER_RADIUS);
      const nodeColor = hasPendingMatch ? COLORS.match : COLORS.user;
      nodeGradient.addColorStop(0, '#fff');
      nodeGradient.addColorStop(0.3, nodeColor);
      nodeGradient.addColorStop(1, nodeColor);
      
      ctx.save();
      ctx.shadowColor = hasPendingMatch ? COLORS.match : COLORS.user;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(user.x, user.y, USER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = nodeGradient;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Label with background
      ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const nameWidth = ctx.measureText(user.name).width + 10;
      drawRoundedRect(ctx, user.x - nameWidth / 2, user.y + USER_RADIUS + 4, nameWidth, 18, 3);
      ctx.fillStyle = 'rgba(22, 27, 34, 0.8)';
      ctx.fill();
      
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(user.name, user.x, user.y + USER_RADIUS + 13);
      
      // Order count badge
      if (userOrders.length > 0) {
        const badgeText = `${userOrders.length}`;
        ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const badgeSize = 14;
        ctx.beginPath();
        ctx.arc(user.x + USER_RADIUS - 2, user.y - USER_RADIUS + 2, badgeSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = hasPendingMatch ? COLORS.match : '#58a6ff';
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(badgeText, user.x + USER_RADIUS - 2, user.y - USER_RADIUS + 3);
      }
    }

    // Draw Center (Clearing House) - Draw last so it's on top
    const hasPendingMatches = orders.some(o => o.matchedWith);
    
    // Outer ring glow
    const centerGlowGradient = ctx.createRadialGradient(centerX, centerY, CENTER_RADIUS, centerX, centerY, CENTER_RADIUS + 25);
    centerGlowGradient.addColorStop(0, hasPendingMatches ? 'rgba(35, 134, 54, 0.5)' : 'rgba(230, 57, 70, 0.3)');
    centerGlowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.beginPath();
    ctx.arc(centerX, centerY, CENTER_RADIUS + 25, 0, Math.PI * 2);
    ctx.fillStyle = centerGlowGradient;
    ctx.fill();

    // Hexagon with gradient
    ctx.save();
    ctx.shadowColor = hasPendingMatches ? '#238636' : COLORS.center;
    ctx.shadowBlur = 20;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const x = centerX + CENTER_RADIUS * Math.cos(angle);
      const y = centerY + CENTER_RADIUS * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    
    const hexGradient = ctx.createLinearGradient(centerX, centerY - CENTER_RADIUS, centerX, centerY + CENTER_RADIUS);
    const hexColor = hasPendingMatches ? '#238636' : COLORS.center;
    hexGradient.addColorStop(0, hexColor);
    hexGradient.addColorStop(1, hasPendingMatches ? '#196c2e' : '#b82e3a');
    ctx.fillStyle = hexGradient;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // Center Label
    ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CLEARING', centerX, centerY - 5);
    ctx.fillText('HOUSE', centerX, centerY + 7);
    
    // Order count below
    if (orders.length > 0) {
      ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(`${orders.length} pending`, centerX, centerY + CENTER_RADIUS + 14);
    }
  }, [getLayout, resolveUser]);

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
          setEventTransport('ws-open');
        } catch {
          // WebSocket unavailable, using polling for events
          setEventTransport('polling');
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
          const orderType = side.toString() === "0" ? "BUY" : "SELL";
          const priceFmt = parseFloat(ethers.formatUnits(price, 18)).toFixed(2);
          const assetName = `Asset #${tokenId}`;
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
          checkForMatches(newOrder);
        });

        // Payment Events
        chEvents.on("PaymentRequestCreated", (id, recipient, sender, amount) => {
          const amountFmt = ethers.formatUnits(amount, 18);
          const senderStr = sender === ethers.ZeroAddress ? 'anyone' : sender.slice(0, 6) + '...';

          addLog(`Payment #${id}: ${senderStr} → ${recipient.slice(0, 6)}... (${amountFmt})`, 'payment');

          const newPayment: PaymentRequest = {
            id: `payment-${id}`,
            paymentId: Number(id),
            recipient: recipient.toLowerCase(),
            sender: sender.toLowerCase(),
            amount: amountFmt,
            amountRaw: BigInt(amount.toString()),
            status: 'pending',
            createdAt: Date.now(),
          };

          paymentsRef.current = [...paymentsRef.current, newPayment];
          bumpPaymentsVersion();
        });

        chEvents.on("PaymentRequestFulfilled", (id, sender, token) => {
          addLog(`Payment #${id} fulfilled by ${sender.slice(0, 6)}... with ${token.slice(0, 6)}...`, 'payment');

          paymentsRef.current = paymentsRef.current.map(p =>
            p.paymentId === Number(id) ? {
              ...p,
              status: 'fulfilled' as const,
              fulfilledToken: token.toLowerCase()
            } : p
          );
          bumpPaymentsVersion();
        });

        chEvents.on("PaymentSettled", (id) => {
          paymentsRef.current = paymentsRef.current.map(p =>
            p.paymentId === Number(id) ? { ...p, status: 'settled' as const } : p
          );
          bumpPaymentsVersion();

          // Remove settled payments after delay
          setTimeout(() => {
            paymentsRef.current = paymentsRef.current.filter(p => p.paymentId !== Number(id));
            bumpPaymentsVersion();
          }, 3000);
        });

        // Swap Events
        chEvents.on("SwapOrderSubmitted", (id, maker, sendAmount, sendToken, receiveAmount) => {
          const sendAmt = ethers.formatUnits(sendAmount, 18);
          const recvAmt = ethers.formatUnits(receiveAmount, 18);

          addLog(`Swap #${id}: ${maker.slice(0, 6)}... offers ${sendAmt} ${sendToken.slice(0, 6)}... for ${recvAmt}`, 'swap');

          const newSwap: SwapOrder = {
            id: `swap-${id}`,
            orderId: Number(id),
            maker: maker.toLowerCase(),
            sendAmount: sendAmt,
            sendAmountRaw: BigInt(sendAmount.toString()),
            sendToken: sendToken.toLowerCase(),
            receiveAmount: recvAmt,
            receiveAmountRaw: BigInt(receiveAmount.toString()),
            status: 'pending',
            createdAt: Date.now(),
          };

          swapsRef.current = [...swapsRef.current, newSwap];
          bumpSwapsVersion();
        });

        chEvents.on("SwapOrderMatched", (id, matchedId) => {
          addLog(`Swap #${id} ↔ #${matchedId} matched!`, 'match');

          swapsRef.current = swapsRef.current.map(s =>
            s.orderId === Number(id) ? { ...s, matchedOrderId: Number(matchedId) } : s
          );
          bumpSwapsVersion();
        });

        chEvents.on("SwapSettled", (id) => {
          swapsRef.current = swapsRef.current.map(s =>
            s.orderId === Number(id) ? { ...s, status: 'settled' as const } : s
          );
          bumpSwapsVersion();

          // Remove settled swaps after delay
          setTimeout(() => {
            swapsRef.current = swapsRef.current.filter(s => s.orderId !== Number(id));
            bumpSwapsVersion();
          }, 3000);
        });

        // Settlement Event (via WebSocket provider)
        chEvents.on("SettlementCompleted", async () => {
          addLog('Settlement cycle executed!', 'success');
          await checkMatches();
          bumpOrdersVersion();
        });

        addLog('Connected to blockchain.', 'success');
      } catch {
        addLog('Failed to connect to blockchain.', 'error');
      }
    };

    init();

    return () => {
      contractsRef.current.ClearingHouse?.removeAllListeners();
      contractsRef.current.ClearingHouseEvents?.removeAllListeners();
      stopAutoTraffic();
    };
  }, [addLog]);

 

  // --------------------------------------------------------------------------
  // CHECK FOR POTENTIAL MATCHES (client-side preview)
  // --------------------------------------------------------------------------
  const checkForMatches = useCallback((newOrder: Order) => {
    const orders = ordersRef.current;
    
    // Find potential matching order (opposite side, same asset)
    // Note: We can only check basic compatibility here since sell orders use 
    // multicurrency terms that are stored on-chain. Actual matching is done by settlement.
    for (const existingOrder of orders) {
      if (existingOrder.id === newOrder.id) continue;
      if (existingOrder.status !== 'pending') continue;
      if (existingOrder.assetAddress !== newOrder.assetAddress) continue;
      if (existingOrder.tokenId !== newOrder.tokenId) continue;
      if (existingOrder.type === newOrder.type) continue; // Must be opposite sides
      
      // For multicurrency sell orders, priceRaw is 0, so we check if there's 
      // a potential match based on same asset/tokenId and opposite sides only
      const buyOrder = newOrder.type === 'BUY' ? newOrder : existingOrder;
      const sellOrder = newOrder.type === 'SELL' ? newOrder : existingOrder;
      
      // Only show as potential match if buy order has a non-zero price
      // Actual price matching is verified by the smart contract
      if (buyOrder.priceRaw > 0n) {
        addLog(`Potential match: #${buyOrder.orderId} ↔ #${sellOrder.orderId} (pending settlement)`, 'match');
        
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
    const settledIds: string[] = [];
    const stillActiveIds: string[] = [];

    for (const order of orders) {
      try {
        const onChainOrder = await ch.orders(order.orderId);
        if (!onChainOrder.active) {
          settledIds.push(order.id);
        } else {
          stillActiveIds.push(order.id);
        }
      } catch {
        // Order may not exist on-chain
      }
    }

    // Clear matchedWith flag for orders that are still active (didn't actually settle)
    if (stillActiveIds.length > 0) {
      ordersRef.current = ordersRef.current.map(o =>
        stillActiveIds.includes(o.id) ? { ...o, matchedWith: undefined } : o
      );
      bumpOrdersVersion();
    }

    if (settledIds.length > 0) {
      addLog(`${settledIds.length} orders settled on-chain!`, 'match');

      // Phase 1: Mark as matched (bright green)
      ordersRef.current = ordersRef.current.map(o =>
        settledIds.includes(o.id) ? { ...o, status: 'matched' as const, createdAt: Date.now() } : o
      );
      bumpOrdersVersion();

      // Phase 2: Mark as clearing (fade out)
      setTimeout(() => {
        ordersRef.current = ordersRef.current.map(o =>
          settledIds.includes(o.id) ? { ...o, status: 'clearing' as const } : o
        );
        bumpOrdersVersion();
      }, 2000);

      // Phase 3: Remove
      setTimeout(() => {
        ordersRef.current = ordersRef.current.filter(o => !settledIds.includes(o.id));
        addLog('Settled orders cleared from view.', 'info');
        bumpOrdersVersion();
      }, 3000);
    } else if (orders.length > 0) {
      addLog('No orders were matched in this settlement cycle.', 'info');
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

      checkForMatches(newOrder);
    };

    const handlePaymentRequestCreated = (id: bigint, recipient: string, sender: string, amount: bigint) => {
      const paymentIdStr = id.toString();
      if (seenPaymentIdsRef.current.has(paymentIdStr)) return;
      seenPaymentIdsRef.current.add(paymentIdStr);

      const amountFmt = ethers.formatUnits(amount, 18);
      const senderStr = sender === ethers.ZeroAddress ? 'anyone' : sender.slice(0, 6) + '...';

      addLog(`(poll) Payment #${id}: ${senderStr} → ${recipient.slice(0, 6)}... (${amountFmt})`, 'payment');

      const newPayment: PaymentRequest = {
        id: `payment-${id}`,
        paymentId: Number(id),
        recipient: recipient.toLowerCase(),
        sender: sender.toLowerCase(),
        amount: amountFmt,
        amountRaw: BigInt(amount.toString()),
        status: 'pending',
        createdAt: Date.now(),
      };

      paymentsRef.current = [...paymentsRef.current, newPayment];
      bumpPaymentsVersion();
    };

    const handlePaymentRequestFulfilled = (id: bigint, sender: string, token: string) => {
      addLog(`(poll) Payment #${id} fulfilled by ${sender.slice(0, 6)}... with ${token.slice(0, 6)}...`, 'payment');

      paymentsRef.current = paymentsRef.current.map(p =>
        p.paymentId === Number(id) ? {
          ...p,
          status: 'fulfilled' as const,
          fulfilledToken: token.toLowerCase()
        } : p
      );
      bumpPaymentsVersion();
    };

    const handlePaymentSettled = (id: bigint) => {
      paymentsRef.current = paymentsRef.current.map(p =>
        p.paymentId === Number(id) ? { ...p, status: 'settled' as const } : p
      );
      bumpPaymentsVersion();

      setTimeout(() => {
        paymentsRef.current = paymentsRef.current.filter(p => p.paymentId !== Number(id));
        bumpPaymentsVersion();
      }, 3000);
    };

    const handleSwapOrderSubmitted = (id: bigint, maker: string, sendAmount: bigint, sendToken: string, receiveAmount: bigint) => {
      const swapIdStr = id.toString();
      if (seenSwapIdsRef.current.has(swapIdStr)) return;
      seenSwapIdsRef.current.add(swapIdStr);

      const sendAmt = ethers.formatUnits(sendAmount, 18);
      const recvAmt = ethers.formatUnits(receiveAmount, 18);

      addLog(`(poll) Swap #${id}: ${maker.slice(0, 6)}... offers ${sendAmt} ${sendToken.slice(0, 6)}... for ${recvAmt}`, 'swap');

      const newSwap: SwapOrder = {
        id: `swap-${id}`,
        orderId: Number(id),
        maker: maker.toLowerCase(),
        sendAmount: sendAmt,
        sendAmountRaw: BigInt(sendAmount.toString()),
        sendToken: sendToken.toLowerCase(),
        receiveAmount: recvAmt,
        receiveAmountRaw: BigInt(receiveAmount.toString()),
        status: 'pending',
        createdAt: Date.now(),
      };

      swapsRef.current = [...swapsRef.current, newSwap];
      bumpSwapsVersion();
    };

    const handleSwapOrderMatched = (id: bigint, matchedId: bigint) => {
      addLog(`(poll) Swap #${id} ↔ #${matchedId} matched!`, 'match');

      swapsRef.current = swapsRef.current.map(s =>
        s.orderId === Number(id) ? { ...s, matchedOrderId: Number(matchedId) } : s
      );
      bumpSwapsVersion();
    };

    const handleSwapSettled = (id: bigint) => {
      swapsRef.current = swapsRef.current.map(s =>
        s.orderId === Number(id) ? { ...s, status: 'settled' as const } : s
      );
      bumpSwapsVersion();

      setTimeout(() => {
        swapsRef.current = swapsRef.current.filter(s => s.orderId !== Number(id));
        bumpSwapsVersion();
      }, 3000);
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
              await checkMatches();
            } else if (parsed.name === 'PaymentRequestCreated') {
              const [id, recipient, sender, amount] = parsed.args;
              handlePaymentRequestCreated(id, recipient, sender, amount);
            } else if (parsed.name === 'PaymentRequestFulfilled') {
              const [id, sender, token] = parsed.args;
              handlePaymentRequestFulfilled(id, sender, token);
            } else if (parsed.name === 'PaymentSettled') {
              const [id] = parsed.args;
              handlePaymentSettled(id);
            } else if (parsed.name === 'SwapOrderSubmitted') {
              const [id, maker, sendAmount, sendToken, receiveAmount] = parsed.args;
              handleSwapOrderSubmitted(id, maker, sendAmount, sendToken, receiveAmount);
            } else if (parsed.name === 'SwapOrderMatched') {
              const [id, matchedId] = parsed.args;
              handleSwapOrderMatched(id, matchedId);
            } else if (parsed.name === 'SwapSettled') {
              const [id] = parsed.args;
              handleSwapSettled(id);
            }
          } catch {
            // Skip unparseable logs
          }
        }

        lastPolledBlockRef.current = latest;
      } catch {
        // Polling error, will retry
      }
    };

    // Immediate poll and start interval
    pollLogs();
    pollIntervalRef.current = setInterval(pollLogs, 2000);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    };
  }, [eventTransport, addLog, checkForMatches, bumpOrdersVersion]);

  // --------------------------------------------------------------------------
  // TRAFFIC SIMULATION
  // --------------------------------------------------------------------------
  const simulateTraffic = async () => {
    if (!contractsRef.current.ClearingHouse) {
      addLog('No contract available', 'error');
      return;
    }

    const provider = providerRef.current;
    const userIndex = Math.floor(Math.random() * config.users.length);
    const userAddress = config.users[userIndex];
    const signer = await provider.getSigner(userAddress);
    const chWithSigner = contractsRef.current.ClearingHouse.connect(signer);

    // Randomly choose transaction type: 40% DvP, 35% Payment, 25% Swap
    const transactionType = Math.random();

    try {
      let tx;
      let txType = 'unknown';

      if (transactionType < 0.4) {
        // DvP Order (40%)
        const isBuy = Math.random() > 0.5;
        const price = ethers.parseUnits((10 + Math.floor(Math.random() * 50)).toString(), 18);
        const assetId = 1 + Math.floor(Math.random() * 3);
        txType = isBuy ? 'BUY order' : 'SELL order';

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
      } else if (transactionType < 0.75) {
        // Payment Request (35%)
        const amount = ethers.parseUnits((100 + Math.floor(Math.random() * 500)).toString(), 18);
        const recipientIndex = Math.floor(Math.random() * config.users.length);
        const recipientAddress = config.users[recipientIndex];
        txType = 'payment request';

        tx = await chWithSigner.createPaymentRequest(
          recipientAddress,
          amount
        );
      } else {
        // PvP Swap (25%)
        const sendAmount = ethers.parseUnits((200 + Math.floor(Math.random() * 800)).toString(), 18);
        const receiveAmount = ethers.parseUnits((180 + Math.floor(Math.random() * 720)).toString(), 18);
        txType = 'swap order';

        tx = await chWithSigner.submitSwapOrder(
          sendAmount,
          config.addresses.TokenA,
          receiveAmount
        );
      }

      addLog(`TX sent: ${tx.hash.slice(0, 10)}... (${txType})`, 'info');
      const receipt = await tx.wait();

      if (receipt.status === 0) {
        addLog(`TX REVERTED in block ${receipt.blockNumber}`, 'error');
      } else if (receipt.logs.length === 0) {
        addLog(`TX mined but no events emitted`, 'error');
      } else {
        addLog(`${txType} confirmed in block ${receipt.blockNumber}`, 'success');
      }
    } catch (e: any) {
      addLog(`Transaction failed: ${e.message?.slice(0, 50) || 'unknown error'}`, 'error');
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

  const triggerSettlement = async () => {
    try {
      await providerRef.current.send("evm_increaseTime", [301]);
      await providerRef.current.send("evm_mine", []);
      const tx = await contractsRef.current.ClearingHouse.performSettlement();
      addLog('Settlement initiated...', 'info');
      await tx.wait();
      addLog('Settlement complete, verifying orders...', 'info');
      // Explicitly check matches after settlement (don't rely solely on event)
      await checkMatches();
    } catch {
      addLog('Settlement failed.', 'error');
    }
  };

  // --------------------------------------------------------------------------
  // RENDER UI
  // --------------------------------------------------------------------------
  const graphWidth = dimensions.w - 440; // Left sidebar + right panel
  const graphHeight = dimensions.h;
  // Trigger re-renders when data changes
  void orderVersion;
  void paymentVersion;
  void swapVersion;
  const currentOrders = [...ordersRef.current]; // Snapshot for rendering
  const currentPayments = [...paymentsRef.current]; // Snapshot for rendering
  const currentSwaps = [...swapsRef.current]; // Snapshot for rendering

  // Connection status indicator
  const connectionStatus = eventTransport === 'ws-open' ? 'WebSocket' : eventTransport === 'polling' ? 'Polling' : 'Connecting...';
  const connectionColor = eventTransport === 'ws-open' ? '#3fb950' : eventTransport === 'polling' ? '#d29922' : '#8b949e';

  return (
    <div style={{ display: 'flex', height: '100vh', background: COLORS.background, color: COLORS.text, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif' }}>
      
      {/* Left Sidebar - Controls */}
      <div style={{
        width: 260,
        padding: 20,
        background: `linear-gradient(180deg, ${COLORS.panelBg} 0%, #0d1117 100%)`,
        borderRight: `1px solid ${COLORS.panelBorder}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ 
              width: 32, 
              height: 32, 
              background: 'linear-gradient(135deg, #e63946 0%, #b82e3a 100%)', 
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
            }}>⬡</div>
            <h1 style={{ margin: 0, fontSize: 20, color: '#fff', fontWeight: 600 }}>ClearingHouse</h1>
          </div>
          <p style={{ margin: '8px 0 0', color: COLORS.textMuted, fontSize: 12 }}>
            Real-time Settlement Visualization
          </p>
          {/* Connection Status */}
          <div style={{ 
            marginTop: 10, 
            display: 'flex', 
            alignItems: 'center', 
            gap: 6,
            fontSize: 11,
            color: connectionColor,
          }}>
            <span style={{ 
              width: 6, 
              height: 6, 
              borderRadius: '50%', 
              background: connectionColor,
              boxShadow: `0 0 6px ${connectionColor}`,
            }} />
            {connectionStatus}
          </div>
        </div>

        {/* Controls Section */}
        <div>
          <h3 style={{ margin: '0 0 12px', fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Controls</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button onClick={simulateTraffic}>+ Create Order</Button>
            <Button 
              onClick={toggleAutoTraffic} 
              style={{ background: isAutoTraffic ? '#da3633' : '#1f6feb' }}
            >
              {isAutoTraffic ? '■ Stop Traffic' : '▶ Auto-Traffic'}
            </Button>
            <Button onClick={triggerSettlement} style={{ background: '#238636' }}>
              ⟳ Settle Orders
            </Button>
          </div>
        </div>

        {/* Transaction Type Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
          <TabButton active={activeTab === 'dvp'} onClick={() => setActiveTab('dvp')}>
            DvP Orders
          </TabButton>
          <TabButton active={activeTab === 'payments'} onClick={() => setActiveTab('payments')}>
            Payments
          </TabButton>
          <TabButton active={activeTab === 'swaps'} onClick={() => setActiveTab('swaps')}>
            PvP Swaps
          </TabButton>
        </div>

        {/* Legend */}
        <div style={{ background: 'rgba(13, 17, 23, 0.6)', padding: 14, borderRadius: 8, border: `1px solid ${COLORS.panelBorder}` }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Legend</h3>
          <LegendItem color={COLORS.center} label="Clearing House" />
          <LegendItem color={COLORS.user} label="Participant" />
          {activeTab === 'dvp' && (
            <>
              <LegendItem color={COLORS.buy} label="Buy Order" isLine />
              <LegendItem color={COLORS.sell} label="Sell Order" isLine />
              <LegendItem color={COLORS.match} label="Matched" isLine />
            </>
          )}
          {activeTab === 'payments' && (
            <>
              <LegendItem color="#00ff88" label="Payment Request" isLine />
              <LegendItem color="#0088ff" label="Fulfilled" isLine />
            </>
          )}
          {activeTab === 'swaps' && (
            <>
              <LegendItem color="#ff8800" label="Swap Order" isLine />
              <LegendItem color={COLORS.match} label="Matched" isLine />
            </>
          )}
        </div>

        {/* Activity Log */}
        <div style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Activity Log</h3>
          <div style={{
            flex: 1,
            background: 'rgba(13, 17, 23, 0.6)',
            border: `1px solid ${COLORS.panelBorder}`,
            borderRadius: 8,
            padding: 10,
            overflowY: 'auto',
            maxHeight: 220,
          }}>
            {logs.length === 0 && (
              <div style={{ color: COLORS.textMuted, fontSize: 11, fontStyle: 'italic' }}>Waiting for activity...</div>
            )}
            {logs.map((log, i) => (
              <div
                key={i}
                style={{
                  fontSize: 10,
                  padding: '4px 0',
                  borderBottom: i < logs.length - 1 ? `1px solid rgba(48, 54, 61, 0.5)` : 'none',
                  color: log.type === 'match' ? COLORS.match : log.type === 'error' ? '#f85149' : log.type === 'success' ? '#3fb950' : COLORS.text,
                }}
              >
                <span style={{ color: COLORS.textMuted, marginRight: 4, fontSize: 9 }}>{log.time}</span>
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

      {/* Right Panel - Transaction Details */}
      <div style={{
        width: 190,
        padding: 16,
        background: `linear-gradient(180deg, ${COLORS.panelBg} 0%, #0d1117 100%)`,
        borderLeft: `1px solid ${COLORS.panelBorder}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          paddingBottom: 12,
          borderBottom: `1px solid ${COLORS.panelBorder}`,
        }}>
          <h2 style={{ margin: 0, fontSize: 14, color: '#fff', fontWeight: 600 }}>
            {activeTab === 'dvp' && 'DvP Order Book'}
            {activeTab === 'payments' && 'Payment Requests'}
            {activeTab === 'swaps' && 'PvP Swap Orders'}
          </h2>
          <div style={{
            marginTop: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <span style={{
              fontSize: 18,
              fontWeight: 700,
              color: (
                (activeTab === 'dvp' && currentOrders.length > 0) ||
                (activeTab === 'payments' && currentPayments.length > 0) ||
                (activeTab === 'swaps' && currentSwaps.length > 0)
              ) ? '#58a6ff' : COLORS.textMuted,
            }}>
              {activeTab === 'dvp' && currentOrders.length}
              {activeTab === 'payments' && currentPayments.length}
              {activeTab === 'swaps' && currentSwaps.length}
            </span>
            <span style={{ fontSize: 11, color: COLORS.textMuted }}>
              active transaction{(currentOrders.length + currentPayments.length + currentSwaps.length) !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* DvP Orders Tab */}
        {activeTab === 'dvp' && (
          <>
            {/* Buy Orders */}
            <div>
              <h3 style={{
                margin: '0 0 8px',
                fontSize: 10,
                color: COLORS.buy,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontWeight: 600,
              }}>
                <span style={{ width: 8, height: 8, background: COLORS.buy, borderRadius: 2 }} />
                BUY ({currentOrders.filter(o => o.type === 'BUY' && o.status === 'pending').length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {currentOrders.filter(o => o.type === 'BUY' && o.status === 'pending').length === 0 ? (
                  <div style={{ fontSize: 10, color: COLORS.textMuted, fontStyle: 'italic', padding: '8px 0' }}>No buy orders</div>
                ) : (
                  currentOrders.filter(o => o.type === 'BUY' && o.status === 'pending').map(order => (
                    <OrderCard key={order.id} order={order} />
                  ))
                )}
              </div>
            </div>

            {/* Sell Orders */}
            <div>
              <h3 style={{
                margin: '0 0 8px',
                fontSize: 10,
                color: COLORS.sell,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontWeight: 600,
              }}>
                <span style={{ width: 8, height: 8, background: COLORS.sell, borderRadius: 2 }} />
                SELL ({currentOrders.filter(o => o.type === 'SELL' && o.status === 'pending').length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {currentOrders.filter(o => o.type === 'SELL' && o.status === 'pending').length === 0 ? (
                  <div style={{ fontSize: 10, color: COLORS.textMuted, fontStyle: 'italic', padding: '8px 0' }}>No sell orders</div>
                ) : (
                  currentOrders.filter(o => o.type === 'SELL' && o.status === 'pending').map(order => (
                    <OrderCard key={order.id} order={order} />
                  ))
                )}
              </div>
            </div>

            {/* Matched Orders */}
            {currentOrders.filter(o => o.matchedWith || o.status === 'matched').length > 0 && (
              <div style={{
                marginTop: 4,
                paddingTop: 12,
                borderTop: `1px solid ${COLORS.panelBorder}`,
              }}>
                <h3 style={{
                  margin: '0 0 8px',
                  fontSize: 10,
                  color: COLORS.match,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontWeight: 600,
                }}>
                  <span style={{
                    width: 8,
                    height: 8,
                    background: COLORS.match,
                    borderRadius: '50%',
                    boxShadow: `0 0 6px ${COLORS.match}`,
                  }} />
                  PENDING MATCHES
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {currentOrders.filter(o => o.matchedWith || o.status === 'matched').map(order => (
                    <OrderCard key={order.id} order={order} isMatch />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Payments Tab */}
        {activeTab === 'payments' && (
          <>
            {/* Pending Payment Requests */}
            <div>
              <h3 style={{
                margin: '0 0 8px',
                fontSize: 10,
                color: '#00ff88',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontWeight: 600,
              }}>
                <span style={{ width: 8, height: 8, background: '#00ff88', borderRadius: 2 }} />
                PENDING ({currentPayments.filter(p => p.status === 'pending').length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {currentPayments.filter(p => p.status === 'pending').length === 0 ? (
                  <div style={{ fontSize: 10, color: COLORS.textMuted, fontStyle: 'italic', padding: '8px 0' }}>No pending payments</div>
                ) : (
                  currentPayments.filter(p => p.status === 'pending').map(payment => (
                    <PaymentCard key={payment.id} payment={payment} />
                  ))
                )}
              </div>
            </div>

            {/* Fulfilled Payments */}
            <div>
              <h3 style={{
                margin: '0 0 8px',
                fontSize: 10,
                color: '#0088ff',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontWeight: 600,
              }}>
                <span style={{ width: 8, height: 8, background: '#0088ff', borderRadius: 2 }} />
                FULFILLED ({currentPayments.filter(p => p.status === 'fulfilled').length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {currentPayments.filter(p => p.status === 'fulfilled').length === 0 ? (
                  <div style={{ fontSize: 10, color: COLORS.textMuted, fontStyle: 'italic', padding: '8px 0' }}>No fulfilled payments</div>
                ) : (
                  currentPayments.filter(p => p.status === 'fulfilled').map(payment => (
                    <PaymentCard key={payment.id} payment={payment} />
                  ))
                )}
              </div>
            </div>
          </>
        )}

        {/* Swaps Tab */}
        {activeTab === 'swaps' && (
          <>
            {/* Pending Swap Orders */}
            <div>
              <h3 style={{
                margin: '0 0 8px',
                fontSize: 10,
                color: '#ff8800',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontWeight: 600,
              }}>
                <span style={{ width: 8, height: 8, background: '#ff8800', borderRadius: 2 }} />
                PENDING ({currentSwaps.filter(s => s.status === 'pending').length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {currentSwaps.filter(s => s.status === 'pending').length === 0 ? (
                  <div style={{ fontSize: 10, color: COLORS.textMuted, fontStyle: 'italic', padding: '8px 0' }}>No pending swaps</div>
                ) : (
                  currentSwaps.filter(s => s.status === 'pending').map(swap => (
                    <SwapCard key={swap.id} swap={swap} />
                  ))
                )}
              </div>
            </div>

            {/* Matched Swaps */}
            {currentSwaps.filter(s => s.matchedOrderId || s.status === 'matched').length > 0 && (
              <div style={{
                marginTop: 4,
                paddingTop: 12,
                borderTop: `1px solid ${COLORS.panelBorder}`,
              }}>
                <h3 style={{
                  margin: '0 0 8px',
                  fontSize: 10,
                  color: COLORS.match,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontWeight: 600,
                }}>
                  <span style={{
                    width: 8,
                    height: 8,
                    background: COLORS.match,
                    borderRadius: '50%',
                    boxShadow: `0 0 6px ${COLORS.match}`,
                  }} />
                  MATCHED ({currentSwaps.filter(s => s.matchedOrderId && s.status === 'pending').length})
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {currentSwaps.filter(s => s.matchedOrderId && s.status === 'pending').map(swap => (
                    <SwapCard key={swap.id} swap={swap} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Settlement Balances Panel - Bottom Center (Compact) */}
      {(() => {
        const matchedOrders = currentOrders.filter(o => o.matchedWith && o.status === 'pending');
        if (matchedOrders.length === 0) return null;

        // Calculate gross and net balances per user
        const userBalances: Record<string, { gross: number; pays: number; receives: number; userName: string }> = {};
        const processedPairs = new Set<string>();

        for (const order of matchedOrders) {
          if (!order.matchedWith) continue;
          const pairKey = [order.id, order.matchedWith].sort().join('-');
          if (processedPairs.has(pairKey)) continue;
          processedPairs.add(pairKey);

          const matchedOrder = matchedOrders.find(o => o.id === order.matchedWith);
          if (!matchedOrder) continue;

          const buyOrder = order.type === 'BUY' ? order : matchedOrder;
          const sellOrder = order.type === 'SELL' ? order : matchedOrder;
          const price = parseFloat(buyOrder.price);

          const userIndex = (userId: string) => {
            const idx = config.users.findIndex(u => u.toLowerCase() === userId);
            return idx >= 0 ? `U${idx + 1}` : userId.slice(0, 4);
          };

          if (!userBalances[buyOrder.userId]) {
            userBalances[buyOrder.userId] = { gross: 0, pays: 0, receives: 0, userName: userIndex(buyOrder.userId) };
          }
          if (!userBalances[sellOrder.userId]) {
            userBalances[sellOrder.userId] = { gross: 0, pays: 0, receives: 0, userName: userIndex(sellOrder.userId) };
          }

          userBalances[buyOrder.userId].pays += price;
          userBalances[buyOrder.userId].gross += price;
          userBalances[sellOrder.userId].receives += price;
          userBalances[sellOrder.userId].gross += price;
        }

        const entries = Object.entries(userBalances);
        if (entries.length === 0) return null;

        return (
          <div style={{
            position: 'fixed',
            bottom: 12,
            left: 275,
            right: 205,
            background: 'rgba(22, 27, 34, 0.95)',
            border: `1px solid ${COLORS.panelBorder}`,
            borderRadius: 8,
            padding: '10px 16px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
            zIndex: 999,
          }}>
            <div style={{ 
              fontSize: 11, 
              color: COLORS.textMuted, 
              textTransform: 'uppercase', 
              letterSpacing: '0.5px',
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span>Settlement Obligations</span>
              <span style={{ color: COLORS.match, fontWeight: 600 }}>{processedPairs.size} matches</span>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {entries.map(([userId, balance]) => {
                const net = balance.receives - balance.pays;
                return (
                  <div key={userId} style={{
                    background: 'rgba(13, 17, 23, 0.8)',
                    border: `1px solid ${net > 0 ? COLORS.buy : net < 0 ? COLORS.sell : COLORS.panelBorder}50`,
                    borderRadius: 4,
                    padding: '6px 10px',
                    fontSize: 11,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    <span style={{ color: '#58a6ff', fontWeight: 700 }}>{balance.userName}</span>
                    <span style={{ color: COLORS.textMuted }}>Gross: <span style={{ color: '#c9d1d9' }}>{balance.gross.toFixed(0)}</span></span>
                    <span style={{ 
                      color: net > 0 ? COLORS.buy : net < 0 ? COLORS.sell : '#c9d1d9',
                      fontWeight: 700,
                    }}>
                      Net: {net > 0 ? '+' : ''}{net.toFixed(0)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}


    </div>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================
function Button({ children, onClick, style = {} }: { children: React.ReactNode; onClick: () => void; style?: React.CSSProperties }) {
  const [isHovered, setIsHovered] = useState(false);
  
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        padding: '10px 14px',
        fontSize: 12,
        fontWeight: 600,
        border: 'none',
        borderRadius: 6,
        background: '#21262d',
        color: '#e6edf3',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        transform: isHovered ? 'translateY(-1px)' : 'none',
        boxShadow: isHovered ? '0 4px 12px rgba(0, 0, 0, 0.3)' : 'none',
        opacity: isHovered ? 0.9 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function LegendItem({ color, label, isLine = false }: { color: string; label: string; isLine?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, fontSize: 11 }}>
      <span
        style={{
          width: isLine ? 16 : 8,
          height: isLine ? 3 : 8,
          background: color,
          borderRadius: isLine ? 2 : 4,
          marginRight: 8,
          boxShadow: `0 0 4px ${color}40`,
        }}
      />
      <span style={{ color: COLORS.textMuted }}>{label}</span>
    </div>
  );
}

function TabButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '6px 8px',
        fontSize: 10,
        fontWeight: active ? 700 : 500,
        border: 'none',
        borderRadius: 4,
        background: active ? COLORS.panelBg : 'rgba(13, 17, 23, 0.4)',
        color: active ? COLORS.text : COLORS.textMuted,
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        borderBottom: active ? `2px solid ${COLORS.user}` : 'none',
      }}
    >
      {children}
    </button>
  );
}

function OrderCard({ order, isMatch = false }: { order: Order; isMatch?: boolean }) {
  const borderColor = isMatch ? COLORS.match : (order.type === 'BUY' ? COLORS.buy : COLORS.sell);
  const age = Math.floor((Date.now() - order.createdAt) / 1000);
  const formatAge = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;

  return (
    <div style={{
      background: 'rgba(13, 17, 23, 0.8)',
      border: `1px solid ${borderColor}40`,
      borderLeft: `3px solid ${borderColor}`,
      borderRadius: 4,
      padding: '6px 10px',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, color: borderColor }}>#{order.orderId}</span>
        <span style={{ color: COLORS.textMuted, flex: 1 }}>{order.asset}</span>
        <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{order.price}</span>
        <span style={{ color: COLORS.textMuted }}>{formatAge(age)}</span>
      </div>
      {order.matchedWith && (
        <div style={{
          marginTop: 4,
          paddingTop: 4,
          borderTop: `1px dashed ${COLORS.panelBorder}`,
          color: COLORS.match,
          fontSize: 10,
        }}>
          ↔ Match #{order.matchedWith.replace('order-', '')}
        </div>
      )}
    </div>
  );
}

function PaymentCard({ payment }: { payment: PaymentRequest }) {
  const borderColor = payment.status === 'fulfilled' ? '#0088ff' : '#00ff88';
  const age = Math.floor((Date.now() - payment.createdAt) / 1000);
  const formatAge = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;

  return (
    <div style={{
      background: 'rgba(13, 17, 23, 0.8)',
      border: `1px solid ${borderColor}40`,
      borderLeft: `3px solid ${borderColor}`,
      borderRadius: 4,
      padding: '6px 10px',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, color: borderColor }}>#{payment.paymentId}</span>
        <span style={{ color: COLORS.textMuted, flex: 1 }}>
          {payment.sender === ethers.ZeroAddress ? 'anyone' : payment.sender.slice(0, 6) + '...'} →
        </span>
        <span style={{ color: COLORS.textMuted }}>{payment.recipient.slice(0, 6) + '...'}</span>
        <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{payment.amount}</span>
        <span style={{ color: COLORS.textMuted }}>{formatAge(age)}</span>
      </div>
      {payment.status === 'fulfilled' && payment.fulfilledToken && (
        <div style={{
          marginTop: 4,
          paddingTop: 4,
          borderTop: `1px dashed ${COLORS.panelBorder}`,
          color: '#0088ff',
          fontSize: 10,
        }}>
          ✓ Fulfilled with {payment.fulfilledToken.slice(0, 6)}...
        </div>
      )}
    </div>
  );
}

function SwapCard({ swap }: { swap: SwapOrder }) {
  const borderColor = swap.matchedOrderId ? COLORS.match : '#ff8800';
  const age = Math.floor((Date.now() - swap.createdAt) / 1000);
  const formatAge = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;

  return (
    <div style={{
      background: 'rgba(13, 17, 23, 0.8)',
      border: `1px solid ${borderColor}40`,
      borderLeft: `3px solid ${borderColor}`,
      borderRadius: 4,
      padding: '6px 10px',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, color: borderColor }}>#{swap.orderId}</span>
        <span style={{ color: COLORS.textMuted, flex: 1 }}>
          {swap.sendAmount} {swap.sendToken.slice(0, 4)} →
        </span>
        <span style={{ color: '#c9d1d9', fontWeight: 600 }}>{swap.receiveAmount}</span>
        <span style={{ color: COLORS.textMuted }}>{formatAge(age)}</span>
      </div>
      {swap.matchedOrderId && (
        <div style={{
          marginTop: 4,
          paddingTop: 4,
          borderTop: `1px dashed ${COLORS.panelBorder}`,
          color: COLORS.match,
          fontSize: 10,
        }}>
          ↔ Match #{swap.matchedOrderId}
        </div>
      )}
    </div>
  );
}
