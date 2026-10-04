// Email texts. Yours are in English (New York time); your partner's are in
// Portuguese, in his time zone (PARTNER_TIMEZONE, default America/Sao_Paulo).
// Each function returns { subject, text }, or { me, partner } when both get one.

import { fmtNY, fmtPT, HOUR } from "./time.js";
import { CONFIRM_WINDOW_MIN, lapseAt } from "./passes.js";
import { PARTNER_REPEAT_HOURS } from "./escalation.js";

const hours = ms => Math.max(0, Math.floor(ms / HOUR));
const when = t => (t ? fmtNY(t) : "none on record");
const quando = (t, tz) => (t ? fmtPT(t, tz) : "nenhum registrado");
const viaEN = { workout: "a qualifying workout", day_pass: "a day pass", vacation: "a vacation pass" };
const viaPT = {
  workout: "fez um treino válido",
  day_pass: "ativou um passe de 1 dia (ele tem poucos por mês)",
  vacation: "está de férias (passe de férias)",
};
const motivoPT = r => (r === "nightly_lockout"
  ? "é horário noturno, quando o Mac fica bloqueado sem exceções"
  : "ele está sem treino em dia");
const sign = "\n\n— Mac Lockout (e-mail automático)";

// ── day / vacation passes (you only) ─────────────────────────────────────────

export const dayAsk = (p, base, policy) => ({
  subject: "Mac Lockout: are you sure you want a day pass?",
  text:
    `You asked for a day pass ${fmtNY(p.requestedAt)}.\nReason: ${p.reason}\n\n` +
    `Are you sure? Open this link to confirm (or cancel):\n${base}/api/confirm?t=${p.token}\n\n` +
    `The link works for ${CONFIRM_WINDOW_MIN / 60} hours (until ${fmtNY(lapseAt(p))}). ` +
    `The pass activates ${policy.dayPassActivateMinutes} minutes after you confirm and lasts ${policy.dayPassHours} h. ` +
    `If you don't confirm, nothing is spent. A workout before it activates cancels it.`,
});

export function notice(n) {
  const p = n.pass;
  switch (n.type) {
    case "day-active": return { subject: `Mac Lockout: day pass active until ${fmtNY(p.endsAt)}`,
      text: `Your day pass is active from ${fmtNY(p.activatesAt)} until ${fmtNY(p.endsAt)}. It covers the workout rule only; the nightly lockout still applies.\nAfter it ends you need a real workout before any other pass.` };
    case "day-lapsed": return { subject: "Mac Lockout: day pass request lapsed (not spent)",
      text: `You didn't confirm the day pass you asked for ${fmtNY(p.requestedAt)}, so it was never used and isn't spent.` };
    case "day-cancelled-workout": return { subject: "Mac Lockout: workout received, day pass cancelled (not spent)",
      text: `A workout arrived before your day pass activated, so the pass was cancelled. It isn't spent.` };
    case "day-cancelled-vacation": return { subject: "Mac Lockout: vacation started, day pass cancelled (not spent)",
      text: `Your vacation started before your day pass activated, so the pass was cancelled. It isn't spent.` };
    case "vacation-started": return { subject: `Mac Lockout: vacation pass active until ${fmtNY(p.endsAt)}`,
      text: `Your vacation pass started ${fmtNY(p.startedAt)} and covers the workout rule until ${fmtNY(p.endsAt)}. The nightly lockout still applies. Shutting the Mac down won't set off the alarm until 12 h after it ends.` };
    case "vacation-waiting": return { subject: "Mac Lockout: your vacation can't start yet: do a workout",
      text: `Your vacation was due to start ${fmtNY(p.start)}, but no pass can follow another pass without a workout in between (your last pass started ${fmtNY(n.view.needsWorkoutAfter)}).\nDo a qualifying workout and the vacation starts right away. It still ends ${fmtNY(n.view.endsAt)}.` };
    case "vacation-blocked": return { subject: "Mac Lockout: your vacation can't start",
      text: `Your vacation was due to start ${fmtNY(p.start)}, but: ${n.view.blockedBy}\nIt doesn't count toward any limit. Cancel or move it.` };
    case "vacation-missed": return { subject: "Mac Lockout: vacation never started (not counted)",
      text: `Your vacation scheduled for ${fmtNY(p.start)} never started, so it doesn't count toward any limit.` };
    default: return { subject: `Mac Lockout: ${n.type}`, text: JSON.stringify(n) };
  }
}

// ── escalation ───────────────────────────────────────────────────────────────

export const warning = ({ since, partnerAt, partnerName, dayLeft, passNeedsWorkoutAfter }) => ({
  subject: "Mac Lockout: you're out of workout compliance",
  text:
    `Your workout compliance ran out ${when(since)}. The Mac stays locked until you do a qualifying workout ` +
    `(≥20 min with ≥5 min above 120 bpm)` +
    (passNeedsWorkoutAfter ? ` (no pass is possible until you've worked out: your last pass started ${fmtNY(passNeedsWorkoutAfter)}).\n\n` : ` or a day pass activates.\n\n`) +
    `If nothing changes, ${partnerName} gets an email ${fmtNY(partnerAt)}, and every ${PARTNER_REPEAT_HOURS} h after that until you're back in compliance.\n` +
    `Day passes left this month: ${dayLeft}. Requesting one holds the emails while it's pending (once per stretch); it doesn't reset the clock.`,
});

export const partnerAlert = ({ since, now, partner, lastWorkout, windowHours }) => ({
  me: {
    subject: `Mac Lockout: ${partner.name} has been told you're out of compliance`,
    text: `You've been out of workout compliance since ${when(since)} (${hours(now - since)} h). ${partner.name} was emailed just now, ` +
      `and will be again every ${PARTNER_REPEAT_HOURS} h until you're back in compliance.\nLast qualifying workout: ${when(lastWorkout)}.`,
  },
  partner: {
    subject: "Randy está sem treinar",
    text:
      `Oi ${partner.name},\n\n` +
      `Este é um aviso automático do compromisso que o Randy fez com você: treinar pelo menos a cada ${windowHours} horas.\n\n` +
      `Ele está sem treino em dia desde ${quando(since, partner.tz)} (há ${hours(now - since)} horas).\n` +
      `Último treino válido: ${quando(lastWorkout, partner.tz)}.\n\n` +
      `O que fazer: mande uma mensagem para ele e cobre. Você não precisa fazer nada técnico.\n\n` +
      `Você vai receber este aviso de novo a cada ${PARTNER_REPEAT_HOURS} horas enquanto ele não voltar a treinar, ` +
      `e um e-mail avisando quando ele voltar.` + sign,
  },
});

export const backOnTrack = ({ since, now, via, partner }) => ({
  me: {
    subject: `Mac Lockout: back in compliance (${partner.name} has been told)`,
    text: `You're back in compliance through ${viaEN[via] || via}, after ${hours(now - since)} h out. ${partner.name} has been told.`,
  },
  partner: {
    subject: "O Randy voltou a cumprir o combinado",
    text: `Oi ${partner.name},\n\nBoa notícia: o Randy ${viaPT[via] || "voltou a cumprir o combinado"}. ` +
      `Ele ficou ${hours(now - since)} horas sem treino em dia.\n\nObrigado por cobrar! Não haverá mais avisos até a próxima vez.` + sign,
  },
});

export const inUse = ({ reason, minutes, since, mode, lastWorkout, partner }) => ({
  me: {
    subject: `Mac Lockout: MacBook in use while denied (${reason})`,
    text: `Your MacBook has reported someone logged in for ${minutes} minutes while access is denied.\n\n` +
      `Reason: ${reason}\nSince: ${fmtNY(since)}\nMac mode: ${mode}` +
      (mode === "enforce" ? " — the logout isn't working." : " — the daemon is in dry-run mode, so it isn't logging you out.") +
      `\nLast satisfactory workout: ${when(lastWorkout)}\n`,
  },
  partner: {
    subject: "Randy está usando o Mac quando deveria estar bloqueado",
    text: `Oi ${partner.name},\n\nO Mac do Randy está sendo usado há ${minutes} minutos num momento em que deveria estar bloqueado ` +
      `(${motivoPT(reason)}), desde ${fmtPT(since, partner.tz)}.\n\n` +
      `Isso pode significar que o bloqueio foi desligado ou contornado. Vale perguntar a ele o que aconteceu.` + sign,
  },
});

export const testEmail = partner => ({
  me: { subject: "Mac Lockout: test email", text: "If you're reading this, Mac Lockout can email you." },
  partner: {
    subject: "Teste: avisos do Mac Lockout do Randy",
    text: `Oi ${partner.name},\n\nEste é só um teste. A partir de agora você pode receber avisos automáticos ` +
      `quando o Randy ficar sem treinar ou burlar o bloqueio do computador dele. Não precisa responder.` + sign,
  },
});
