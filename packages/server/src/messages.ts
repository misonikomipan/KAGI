import type { CommandFailureReason } from "@kagi/core";

export interface Messages {
  lang: string;
  signedInAs: (name: string) => string;
  unlockButton: string;
  unlocked: string;
  unlockedUnverified: string;
  denied: string;
  failed: Record<CommandFailureReason, string>;
  retry: string;
  cooldown: (seconds: number) => string;
  notFound: string;
  back: string;
}

export const en: Messages = {
  lang: "en",
  signedInAs: (name) => `Signed in as ${name}`,
  unlockButton: "Unlock",
  unlocked: "Unlocked",
  unlockedUnverified: "Unlock command sent. Check that the door is open.",
  denied: "You are not allowed to open this door.",
  failed: {
    device_offline: "The lock or its hub is offline.",
    jammed: "The lock is jammed.",
    unauthorized: "KAGI could not authenticate with the lock vendor.",
    rate_limited: "Too many requests to the lock vendor. Wait a moment.",
    timeout: "The lock did not respond in time.",
    invalid_device: "This door is misconfigured.",
    vendor_error: "The lock vendor returned an error.",
  },
  retry: "Try again",
  cooldown: (s) => `Just pressed. Try again in ${s} s.`,
  notFound: "Unknown door.",
  back: "Back",
};

export const ja: Messages = {
  lang: "ja",
  signedInAs: (name) => `${name} としてログイン中`,
  unlockButton: "開ける",
  unlocked: "開きました",
  unlockedUnverified: "解錠の指示を送りました。開いたか確かめてください。",
  denied: "このドアを開ける権限がありません。",
  failed: {
    device_offline: "鍵またはハブがオフラインです。",
    jammed: "鍵が引っかかって動きませんでした。",
    unauthorized: "鍵メーカーの認証に失敗しました。",
    rate_limited: "鍵メーカーへのリクエストが多すぎます。少し待ってください。",
    timeout: "鍵から時間内に応答がありませんでした。",
    invalid_device: "このドアの設定に誤りがあります。",
    vendor_error: "鍵メーカーでエラーが起きました。",
  },
  retry: "もう一度",
  cooldown: (s) => `押したばかりです。${s} 秒後にもう一度どうぞ。`,
  notFound: "そのドアは見つかりません。",
  back: "戻る",
};
