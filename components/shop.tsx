"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type PublicKey,
} from "@solana/web3.js";
import {
  encodeURL,
  findReference,
  FindReferenceError,
  validateTransfer,
} from "@solana/pay";

import {
  createFindReferenceRpc,
  createValidateTransferRpc,
} from "@/lib/solana-pay-rpc";
import {
  FAUCET_URL,
  MERCHANT_PUBLIC_KEY,
  MERCHANT_WALLET,
  PAYMENT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PRODUCTS,
  SOLANA_PAY_LABEL,
  WALLET_FEE_LAMPORTS,
  explorerAddressUrl,
  explorerTxUrl,
  formatPrice,
  formatSol,
  shortenAddress,
  sleep,
  type Product,
} from "@/lib/shop";

type OrderStatus = "waiting" | "confirmed" | "failed";
type ShopStatus = "disconnected" | "ready" | OrderStatus;
type WalletNetwork = "mainnet" | "devnet" | "testnet" | "unknown";
type WalletState = ReturnType<typeof useWallet>;
type TransferRequest = Extract<
  Parameters<typeof encodeURL>[0],
  { recipient: unknown }
>;
type PayAddress = Parameters<typeof findReference>[1];
type TransferFields = Parameters<typeof validateTransfer>[2];

type Order = {
  id: string;
  product: Product;
  reference: PublicKey;
  url: string;
  status: OrderStatus;
  signature?: string;
  error?: string;
};

const STATUS_META: Record<
  ShopStatus,
  { label: string; description: string; dotClass: string; containerClass: string }
> = {
  disconnected: {
    label: "Not connected",
    description: "Connect Phantom for the browser flow, or scan a QR with any wallet.",
    dotClass: "bg-zinc-400",
    containerClass: "border-zinc-500/30 bg-zinc-500/10 text-zinc-300",
  },
  ready: {
    label: "Ready to pay",
    description: "Pick a product to create a fresh Solana Pay order.",
    dotClass: "bg-violet-400",
    containerClass: "border-violet-500/30 bg-violet-500/10 text-violet-200",
  },
  waiting: {
    label: "Waiting for payment",
    description: "Scan the QR or approve the transaction in Phantom.",
    dotClass: "animate-pulse bg-amber-400",
    containerClass: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  },
  confirmed: {
    label: "Payment confirmed",
    description: "The transfer was found and verified on Solana DevNet.",
    dotClass: "bg-emerald-400",
    containerClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  },
  failed: {
    label: "Payment failed",
    description: "Nothing was charged. Try again with a fresh reference.",
    dotClass: "bg-rose-400",
    containerClass: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  },
};

const NETWORK_META: Record<
  WalletNetwork,
  { label: string; className: string }
> = {
  devnet: {
    label: "DevNet",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  },
  testnet: {
    label: "Testnet mode",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  },
  mainnet: {
    label: "Mainnet",
    className: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  },
  unknown: {
    label: "Network unknown",
    className: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
  },
};

const emptySubscribe = () => () => {};

function useMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

function toPayAddress(value: string): PayAddress {
  return value as PayAddress;
}

function detectWalletNetwork(wallet: WalletState["wallet"]): WalletNetwork {
  if (typeof window === "undefined") return "unknown";

  const phantomWindow = window as unknown as {
    phantom?: { solana?: Record<string, unknown> };
    solana?: Record<string, unknown>;
  };
  const phantom = phantomWindow.phantom?.solana ?? phantomWindow.solana;

  if (phantom) {
    const providerConnection = phantom.connection as
      | { rpcEndpoint?: unknown }
      | undefined;
    const candidates = [
      phantom.chain,
      phantom.network,
      phantom.cluster,
      phantom._network,
      providerConnection?.rpcEndpoint,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const value = candidate.toLowerCase();
      if (value.includes("mainnet")) return "mainnet";
      if (value.includes("devnet")) return "devnet";
      if (value.includes("testnet")) return "testnet";
    }
  }

  const adapter = wallet?.adapter as unknown as {
    wallet?: {
      accounts?: ReadonlyArray<{ chains?: readonly string[] }>;
    };
  };
  const chains = adapter?.wallet?.accounts?.[0]?.chains;

  if (Array.isArray(chains)) {
    const hasMainnet = chains.includes("solana:mainnet");
    const hasDevnet = chains.includes("solana:devnet");
    const hasTestnet = chains.includes("solana:testnet");

    if (hasMainnet && !hasDevnet && !hasTestnet) return "mainnet";
    if (hasDevnet && !hasMainnet) return "devnet";
    if (hasTestnet && !hasMainnet) return "testnet";
  }

  return "unknown";
}

function getPaymentErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("user rejected") ||
    lower.includes("rejected") ||
    lower.includes("declined") ||
    lower.includes("cancelled") ||
    lower.includes("canceled")
  ) {
    return "Payment cancelled — you rejected the request in your wallet. Nothing was sent.";
  }

  if (lower.includes("insufficient") || lower.includes("0x1")) {
    return `Insufficient DevNet SOL to complete this payment. Get free DevNet SOL at ${FAUCET_URL} and try again.`;
  }

  if (lower.includes("blockhash")) {
    return "The transaction expired before it was approved. Please try again.";
  }

  return `Payment failed: ${message}`;
}

function SolanaPayQr({ value }: { value: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    container.innerHTML = "";
    setFailed(false);

    import("@solana/pay")
      .then(({ createQR }) => {
        if (cancelled) return;
        container.innerHTML = "";
        const qr = createQR(value, 280, "#ffffff", "#111827");
        qr.append(container);
      })
      .catch((error) => {
        console.error("Could not render the Solana Pay QR code", error);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
  }, [value]);

  return (
    <div className="w-full max-w-[312px]">
      <div
        ref={containerRef}
        className="aspect-square w-full overflow-hidden rounded-2xl bg-white p-4 [&_svg]:h-auto [&_svg]:w-full"
        aria-label="Solana Pay QR code"
        role="img"
      />
      {failed ? (
        <p className="mt-2 text-center text-xs text-rose-300">
          Could not render the QR code. Refresh the page and try again.
        </p>
      ) : null}
    </div>
  );
}

export default function Shop() {
  const { connection } = useConnection();
  const { connected, publicKey, wallet, signTransaction } = useWallet();

  const mounted = useMounted();
  const [order, setOrder] = useState<Order | null>(null);
  const [balanceLamports, setBalanceLamports] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [walletPaying, setWalletPaying] = useState(false);
  const [walletNetwork, setWalletNetwork] = useState<WalletNetwork>("unknown");
  const orderPanelRef = useRef<HTMLDivElement>(null);

  const uiConnected = mounted && connected;
  const status: ShopStatus = order
    ? order.status
    : uiConnected
      ? "ready"
      : "disconnected";
  const statusMeta = STATUS_META[status];
  const networkMeta = NETWORK_META[walletNetwork];

  const refreshBalance = useCallback(async () => {
    if (!publicKey) {
      setBalanceLamports(null);
      return;
    }

    setBalanceLoading(true);
    try {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setBalanceLamports(lamports);
    } catch (error) {
      console.error("Could not load the DevNet balance", error);
      setBalanceLamports(null);
    } finally {
      setBalanceLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refreshBalance();
    }, 0);
    const interval = window.setInterval(() => {
      void refreshBalance();
    }, 15_000);

    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refreshBalance]);

  useEffect(() => {
    if (!connected) return;

    const updateNetwork = () => {
      setWalletNetwork(detectWalletNetwork(wallet));
    };

    const initial = window.setTimeout(updateNetwork, 0);
    const interval = window.setInterval(updateNetwork, 3_000);
    window.addEventListener("focus", updateNetwork);

    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", updateNetwork);
    };
  }, [connected, wallet]);

  const orderId = order?.id;
  const orderStatus = order?.status;
  const orderReference = order?.reference;
  const orderPrice = order?.product.price;

  useEffect(() => {
    if (
      !orderId ||
      orderStatus !== "waiting" ||
      !orderReference ||
      orderPrice === undefined
    ) {
      return;
    }

    let cancelled = false;
    const findRpc = createFindReferenceRpc(connection);
    const validateRpc = createValidateTransferRpc(connection.rpcEndpoint);
    const reference = toPayAddress(orderReference.toBase58());
    const transferFields: TransferFields = {
      recipient: toPayAddress(MERCHANT_WALLET),
      amount: orderPrice,
      reference,
    };
    const startedAt = Date.now();

    const run = async () => {
      while (!cancelled && Date.now() - startedAt < PAYMENT_TIMEOUT_MS) {
        let found;

        try {
          found = await findReference(findRpc, reference, {
            commitment: "confirmed",
          });
        } catch (error) {
          if (cancelled) return;
          if (!(error instanceof FindReferenceError)) {
            console.warn("Reference lookup failed; retrying…", error);
          }
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        if (cancelled) return;

        setOrder((previous) =>
          previous && previous.id === orderId
            ? { ...previous, signature: found.signature }
            : previous,
        );

        let validated = false;
        let validationError: unknown = null;

        for (let attempt = 0; attempt < 8 && !cancelled; attempt += 1) {
          try {
            await validateTransfer(
              validateRpc,
              found.signature,
              transferFields,
              { commitment: "confirmed" },
            );
            validated = true;
            break;
          } catch (error) {
            validationError = error;
            await sleep(1_500);
          }
        }

        if (cancelled) return;

        if (validated) {
          setOrder((previous) =>
            previous && previous.id === orderId
              ? {
                  ...previous,
                  status: "confirmed",
                  signature: found.signature,
                  error: undefined,
                }
              : previous,
          );
          void refreshBalance();
          return;
        }

        const detail =
          validationError instanceof Error
            ? validationError.message
            : "Unknown validation error";
        setOrder((previous) =>
          previous && previous.id === orderId
            ? {
                ...previous,
                status: "failed",
                signature: found.signature,
                error: `A transaction was found for this order, but it could not be verified as a ${orderPrice} SOL payment to the shop. ${detail}`,
              }
            : previous,
        );
        return;
      }

      if (!cancelled) {
        setOrder((previous) =>
          previous && previous.id === orderId
            ? {
                ...previous,
                status: "failed",
                error:
                  'Payment not found after 2 minutes. The QR may have expired. Click "Try again" to generate a new reference and QR code.',
              }
            : previous,
        );
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    connection,
    orderId,
    orderStatus,
    orderReference,
    orderPrice,
    refreshBalance,
  ]);

  const startOrder = useCallback((product: Product) => {
    const reference = new Keypair().publicKey;
    const url = encodeURL({
      recipient: toPayAddress(MERCHANT_WALLET),
      amount: product.price,
      reference: toPayAddress(reference.toBase58()),
      label: SOLANA_PAY_LABEL,
      message: product.name,
    } satisfies TransferRequest);

    setOrder({
      id: reference.toBase58(),
      product,
      reference,
      url: url.toString(),
      status: "waiting",
    });

    if (window.matchMedia("(max-width: 1023px)").matches) {
      window.setTimeout(() => {
        orderPanelRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 50);
    }
  }, []);

  const cancelOrder = useCallback(() => {
    setOrder(null);
  }, []);

  const retryOrder = useCallback(() => {
    if (order) {
      startOrder(order.product);
    }
  }, [order, startOrder]);

  const payWithConnectedWallet = useCallback(async () => {
    if (!order || order.status !== "waiting") return;

    if (!connected || !publicKey) {
      setOrder((previous) =>
        previous && previous.id === order.id
          ? {
              ...previous,
              status: "failed",
              error:
                "Connect Phantom to pay with your browser wallet, or scan the QR with Phantom mobile.",
            }
          : previous,
      );
      return;
    }

    if (!signTransaction) {
      setOrder((previous) =>
        previous && previous.id === order.id
          ? {
              ...previous,
              status: "failed",
              error:
                "This wallet cannot sign transactions in the browser. Please scan the QR code with Phantom mobile instead.",
            }
          : previous,
      );
      return;
    }

    if (walletNetwork === "mainnet") {
      setOrder((previous) =>
        previous && previous.id === order.id
          ? {
              ...previous,
              status: "failed",
              error:
                "Phantom is on Mainnet. Switch to DevNet / Testnet Mode before paying. No mainnet transaction was sent.",
            }
          : previous,
      );
      return;
    }

    setWalletPaying(true);
    try {
      const balance = await connection.getBalance(publicKey, "confirmed");
      setBalanceLamports(balance);

      const lamports = Math.round(order.product.price * LAMPORTS_PER_SOL);
      const required = lamports + WALLET_FEE_LAMPORTS;

      if (balance < required) {
        setOrder((previous) =>
          previous && previous.id === order.id
            ? {
                ...previous,
                status: "failed",
                error: `Insufficient DevNet SOL. This order needs about ${formatSol(required)} SOL including the network fee, but your wallet has ${formatSol(balance)} SOL. Get free DevNet SOL at ${FAUCET_URL} and try again.`,
              }
            : previous,
        );
        return;
      }

      const transfer = SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: MERCHANT_PUBLIC_KEY,
        lamports,
      });
      const transferWithReference = new TransactionInstruction({
        programId: transfer.programId,
        keys: [
          ...transfer.keys,
          {
            pubkey: order.reference,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: transfer.data,
      });
      const transaction = new Transaction().add(transferWithReference);
      transaction.feePayer = publicKey;
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = latestBlockhash.blockhash;

      const signed = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(
        signed.serialize(),
        {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        },
      );

      setOrder((previous) =>
        previous && previous.id === order.id
          ? { ...previous, signature }
          : previous,
      );
      void refreshBalance();
    } catch (error) {
      const message = getPaymentErrorMessage(error);
      setOrder((previous) =>
        previous && previous.id === order.id
          ? { ...previous, status: "failed", error: message }
          : previous,
      );
    } finally {
      setWalletPaying(false);
    }
  }, [
    connected,
    publicKey,
    signTransaction,
    connection,
    order,
    walletNetwork,
    refreshBalance,
  ]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_at_top,rgba(124,58,237,0.2),transparent_62%)]" />

      <main className="relative mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              DevNet only — no real money
            </span>
            <h1 className="mt-4 text-4xl font-bold tracking-tight text-white sm:text-5xl">
              Solana Pay Mini-Shop
            </h1>
            <p className="mt-3 max-w-xl text-base text-zinc-400">
              Pay with Solana Pay on DevNet
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 sm:max-w-sm lg:items-end">
            {mounted ? (
              <WalletMultiButton className="!h-11 !rounded-xl !bg-violet-600 !px-5 !font-sans !text-sm !font-semibold hover:!bg-violet-500" />
            ) : (
              <div className="h-11 w-40 animate-pulse rounded-xl bg-white/10" />
            )}

            {uiConnected && publicKey ? (
              <div className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-sm font-medium text-emerald-300">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    Connected
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${networkMeta.className}`}
                  >
                    {networkMeta.label}
                  </span>
                </div>
                <a
                  href={explorerAddressUrl(publicKey.toBase58())}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block font-mono text-xs text-zinc-300 underline-offset-2 hover:text-violet-300 hover:underline"
                >
                  {shortenAddress(publicKey.toBase58(), 6)}
                </a>
                <p className="mt-1 text-xs text-zinc-400">
                  DevNet balance:{" "}
                  <span className="font-mono text-zinc-200">
                    {balanceLamports === null
                      ? balanceLoading
                        ? "Loading…"
                        : "Unavailable"
                      : `${formatSol(balanceLamports)} SOL`}
                  </span>
                </p>
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                  <a
                    href={FAUCET_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-violet-300 underline-offset-2 hover:underline"
                  >
                    Get DevNet SOL ↗
                  </a>
                  {walletNetwork === "testnet" ? (
                    <span className="text-amber-300">Select DevNet</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-sm font-medium text-zinc-200">
                  Wallet not connected
                </p>
                <p className="mt-1 text-xs leading-5 text-zinc-400">
                  Connect Phantom for the browser-wallet flow, or scan a QR with
                  any Solana wallet.
                </p>
              </div>
            )}
          </div>
        </header>

        <div
          className={`mt-6 flex flex-col gap-2 rounded-2xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${statusMeta.containerClass}`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${statusMeta.dotClass}`} />
            <span className="text-sm font-semibold">{statusMeta.label}</span>
          </div>
          <p className="text-xs opacity-80">{statusMeta.description}</p>
        </div>

        {uiConnected && walletNetwork === "mainnet" ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-100"
          >
            <p className="font-semibold">
              Mainnet wallet detected — switch to DevNet / Testnet Mode
            </p>
            <p className="mt-1 text-rose-200/80">
              This shop only works on DevNet. In Phantom, open Settings →
              Developer Settings → enable Testnet Mode, select DevNet, then
              reconnect. Do not send mainnet funds.
            </p>
          </div>
        ) : null}

        {uiConnected && walletNetwork === "unknown" ? (
          <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <p className="font-semibold">
              DevNet only — check Phantom&apos;s network
            </p>
            <p className="mt-1 text-amber-200/80">
              We could not detect Phantom&apos;s network. Make sure Testnet Mode
              is on (Settings → Developer Settings → Testnet Mode) and DevNet is
              selected before paying.
            </p>
          </div>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <section aria-labelledby="products-heading">
            <div className="flex items-end justify-between gap-3">
              <h2
                id="products-heading"
                className="text-lg font-semibold text-white"
              >
                Products
              </h2>
              <p className="text-xs text-zinc-500">4 items · DevNet SOL</p>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {PRODUCTS.map((product) => {
                const isActive =
                  order?.product.id === product.id && status !== "confirmed";
                const isDisabled = status === "waiting";

                return (
                  <article
                    key={product.id}
                    className={`flex flex-col rounded-2xl border p-5 transition ${
                      isActive
                        ? "border-violet-500/60 bg-violet-500/[0.06]"
                        : "border-white/10 bg-white/[0.03] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-3xl" aria-hidden="true">
                        {product.emoji}
                      </span>
                      <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 font-mono text-xs text-zinc-300">
                        {formatPrice(product.price)} SOL
                      </span>
                    </div>
                    <h3 className="mt-4 text-base font-semibold text-white">
                      {product.name}
                    </h3>
                    <p className="mt-1 flex-1 text-sm text-zinc-400">
                      {product.description}
                    </p>
                    <button
                      type="button"
                      onClick={() => startOrder(product)}
                      disabled={isDisabled}
                      className="mt-5 inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isDisabled && isActive ? "Waiting…" : "Pay"}
                    </button>
                  </article>
                );
              })}
            </div>

            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Merchant wallet
              </p>
              <a
                href={explorerAddressUrl(MERCHANT_WALLET)}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block break-all font-mono text-xs text-zinc-300 underline-offset-2 hover:text-violet-300 hover:underline"
              >
                {MERCHANT_WALLET}
              </a>
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                All payments go to this public DevNet address. No secret keys,
                seed phrases, or real money are involved.
              </p>
            </div>
          </section>

          <aside ref={orderPanelRef} className="scroll-mt-6 lg:sticky lg:top-6">
            {!order ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] p-6">
                <p className="text-sm font-semibold text-zinc-200">
                  Your order
                </p>
                <p className="mt-2 text-sm text-zinc-400">
                  Pick a product to create a fresh Solana Pay order.
                </p>
                <ol className="mt-5 space-y-3 text-xs leading-5 text-zinc-400">
                  <li className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/15 font-mono text-[11px] text-violet-300">
                      1
                    </span>
                    Choose a product and generate a one-time reference.
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/15 font-mono text-[11px] text-violet-300">
                      2
                    </span>
                    Scan the QR with Phantom mobile or pay from the connected
                    wallet.
                  </li>
                  <li className="flex gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/15 font-mono text-[11px] text-violet-300">
                      3
                    </span>
                    The app verifies the DevNet transfer and shows a receipt.
                  </li>
                </ol>
                <p className="mt-5 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-zinc-400">
                  No wallet? No problem. The QR flow works with Phantom mobile
                  even if no browser wallet is connected.
                </p>
              </div>
            ) : null}

            {order && status === "waiting" ? (
              <div className="overflow-hidden rounded-3xl border border-amber-500/30 bg-amber-500/[0.04]">
                <div className="border-b border-white/10 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-300">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                      Waiting for payment
                    </span>
                    <span className="font-mono text-xs text-zinc-400">
                      {formatPrice(order.product.price)} SOL
                    </span>
                  </div>
                  <h2 className="mt-3 text-2xl font-semibold text-white">
                    {order.product.name}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    Scan with Phantom mobile, or pay with your connected wallet
                    below.
                  </p>
                </div>

                <div className="flex flex-col items-center gap-4 p-5">
                  <SolanaPayQr value={order.url} />
                  <p className="text-center text-xs leading-5 text-zinc-400">
                    Open Phantom → Scan → approve the{" "}
                    {formatPrice(order.product.price)} SOL DevNet payment.
                  </p>

                  {order.signature ? (
                    <div className="w-full rounded-xl border border-white/10 bg-black/20 p-3 text-xs">
                      <p className="text-zinc-400">
                        Transaction found — confirming…
                      </p>
                      <a
                        href={explorerTxUrl(order.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block break-all font-mono text-violet-300 underline-offset-2 hover:underline"
                      >
                        {order.signature}
                      </a>
                    </div>
                  ) : null}

                  <div className="flex w-full flex-col gap-2">
                    {uiConnected ? (
                      <button
                        type="button"
                        onClick={() => void payWithConnectedWallet()}
                        disabled={
                          walletPaying || walletNetwork === "mainnet"
                        }
                        className="inline-flex h-11 items-center justify-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {walletPaying
                          ? "Approve in Phantom…"
                          : walletNetwork === "mainnet"
                            ? "Switch Phantom to DevNet first"
                            : "Pay with connected wallet"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={cancelOrder}
                      className="inline-flex h-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] px-4 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.07]"
                    >
                      Cancel order
                    </button>
                  </div>

                  <p className="text-center text-[11px] leading-5 text-zinc-500">
                    Listening on DevNet for up to 2 minutes. This order has a
                    unique reference:{" "}
                    <span className="font-mono">
                      {shortenAddress(order.reference.toBase58(), 4)}
                    </span>
                  </p>
                </div>
              </div>
            ) : null}

            {order && status === "failed" ? (
              <div className="overflow-hidden rounded-3xl border border-rose-500/30 bg-rose-500/[0.04]">
                <div className="border-b border-white/10 p-5">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-rose-300">
                    <span className="h-2 w-2 rounded-full bg-rose-400" />
                    Payment failed
                  </span>
                  <h2 className="mt-3 text-2xl font-semibold text-white">
                    {order.product.name}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {formatPrice(order.product.price)} SOL · DevNet
                  </p>
                </div>

                <div className="space-y-4 p-5">
                  <p className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm leading-6 text-rose-100">
                    {order.error ?? "Something went wrong."}
                  </p>

                  {order.error?.includes(FAUCET_URL) ? (
                    <a
                      href={FAUCET_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex text-xs font-semibold text-violet-300 underline-offset-2 hover:underline"
                    >
                      Open the DevNet faucet ↗
                    </a>
                  ) : null}

                  {order.signature ? (
                    <div className="text-xs">
                      <p className="text-zinc-400">Transaction signature</p>
                      <a
                        href={explorerTxUrl(order.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block break-all font-mono text-violet-300 underline-offset-2 hover:underline"
                      >
                        {order.signature}
                      </a>
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={retryOrder}
                      className="inline-flex h-11 items-center justify-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition hover:bg-violet-500"
                    >
                      Try again with a new reference
                    </button>
                    <button
                      type="button"
                      onClick={cancelOrder}
                      className="inline-flex h-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] px-4 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.07]"
                    >
                      Cancel
                    </button>
                  </div>

                  <p className="text-[11px] leading-5 text-zinc-500">
                    Try again creates a brand-new Solana Pay reference and QR
                    code. The previous reference is never reused.
                  </p>
                </div>
              </div>
            ) : null}

            {order && status === "confirmed" ? (
              <div className="overflow-hidden rounded-3xl border border-emerald-500/30 bg-emerald-500/[0.05]">
                <div className="border-b border-white/10 p-5">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-300">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    Payment confirmed
                  </span>
                  <h2 className="mt-3 text-2xl font-semibold text-white">
                    {order.product.name}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    Verified on Solana DevNet
                  </p>
                </div>

                <div className="space-y-4 p-5">
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <dt className="text-xs text-zinc-500">Amount paid</dt>
                      <dd className="mt-1 font-mono text-zinc-100">
                        {formatPrice(order.product.price)} SOL
                      </dd>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <dt className="text-xs text-zinc-500">Network</dt>
                      <dd className="mt-1 text-zinc-100">DevNet</dd>
                    </div>
                  </dl>

                  {order.signature ? (
                    <div>
                      <p className="text-xs text-zinc-500">
                        Transaction signature
                      </p>
                      <code className="mt-1 block break-all rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-[11px] leading-5 text-zinc-300">
                        {order.signature}
                      </code>
                      <a
                        href={explorerTxUrl(order.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex text-xs font-semibold text-violet-300 underline-offset-2 hover:underline"
                      >
                        View on Solana Explorer ↗
                      </a>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    onClick={cancelOrder}
                    className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition hover:bg-violet-500"
                  >
                    New order
                  </button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>

        <footer className="mt-10 flex flex-col gap-2 border-t border-white/10 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>Solana Pay Mini-Shop · DevNet only · No real money</p>
          <p>
            Merchant:{" "}
            <a
              href={explorerAddressUrl(MERCHANT_WALLET)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-zinc-400 underline-offset-2 hover:text-violet-300 hover:underline"
            >
              {shortenAddress(MERCHANT_WALLET, 6)}
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}
