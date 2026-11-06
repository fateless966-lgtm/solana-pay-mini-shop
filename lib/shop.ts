import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export const DEVNET_ENDPOINT = "https://api.devnet.solana.com";

/** Public DevNet address of the shop owner. No secret key is stored in this app. */
// export const MERCHANT_WALLET =
//   "ETg62c95bHoBY2ndXVQxLsTiggn5hLUHkKTLGWsbuKY6";
export const MERCHANT_WALLET =
  "ByyrpzF3Fw747UsRHFB1jgtGfccJo5zss6mj9FrKyfpQ";
export const MERCHANT_PUBLIC_KEY = new PublicKey(MERCHANT_WALLET);

export const SOLANA_PAY_LABEL = "Solana Pay Mini-Shop";
export const FAUCET_URL = "https://faucet.solana.com";
export const EXPLORER_CLUSTER = "devnet";

export const PAYMENT_TIMEOUT_MS = 120_000;
export const POLL_INTERVAL_MS = 2_000;
export const WALLET_FEE_LAMPORTS = 5_000;

export const PRODUCTS = [
  {
    id: "coffee",
    name: "Coffee",
    price: 0.05,
    emoji: "☕",
    description: "A fresh cup of DevNet coffee.",
  },
  {
    id: "sticker-pack",
    name: "Sticker Pack",
    price: 0.02,
    emoji: "✨",
    description: "A pack of Solana stickers for your laptop.",
  },
  {
    id: "notebook",
    name: "Notebook",
    price: 0.1,
    emoji: "📓",
    description: "For your next big hackathon idea.",
  },
  {
    id: "solana-tshirt",
    name: "Solana Logo T-Shirt",
    price: 0.25,
    emoji: "👕",
    description: "Show your Solana colors IRL.",
  },
] as const;

export type Product = (typeof PRODUCTS)[number];

export function formatPrice(price: number): string {
  return price.toFixed(2);
}

export function formatSol(lamports: number, digits = 4): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(digits);
}

export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${EXPLORER_CLUSTER}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${EXPLORER_CLUSTER}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
