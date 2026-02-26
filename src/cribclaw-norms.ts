/**
 * CribClaw Pattern Detection Module
 *
 * Observational stats based on your baby's own logged data.
 * No external reference ranges, no medical guidelines, no advice.
 */

import { CRIBCLAW_BABY_DOB } from './config.js';
import {
  getBabyDailySummary,
  getBabyEventTimes,
  getRecentBabySleepSessions,
  getTummyTimeTotal,
} from './db.js';

// ── Helper Functions ─────────────────────────────────────────────────

export function getBabyAgeDays(): number | null {
  if (!CRIBCLAW_BABY_DOB) return null;
  const dobMs = Date.parse(CRIBCLAW_BABY_DOB);
  if (!Number.isFinite(dobMs)) return null;
  return Math.floor((Date.now() - dobMs) / (24 * 60 * 60 * 1000));
}

export function getBabyAgeMonths(): number | null {
  const days = getBabyAgeDays();
  if (days === null) return null;
  return days / 30.44;
}

// ── Public API ───────────────────────────────────────────────────────

export interface AgeInsight {
  category: 'feeding' | 'sleep' | 'diapers' | 'tummy_time';
  status: 'info';
  message: string;
}

/**
 * Generate observational stats from this baby's own logged data.
 * No comparisons to external norms. Just numbers.
 */
export function getAgeBasedInsights(chatJid: string): AgeInsight[] {
  const insights: AgeInsight[] = [];
  const now = new Date().toISOString();
  const summary = getBabyDailySummary(chatJid, now);

  // Feed count
  if (summary.feeds > 0) {
    insights.push({
      category: 'feeding',
      status: 'info',
      message: `Feeds today: ${summary.feeds}.`,
    });
  }

  // Sleep
  const sleepSessions = getRecentBabySleepSessions(chatJid, 10);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todaySleepMin = sleepSessions
    .filter((s) => Date.parse(s.ended_at) >= todayStart.getTime())
    .reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
  const todaySleepHrs = todaySleepMin / 60;

  if (todaySleepHrs > 0) {
    insights.push({
      category: 'sleep',
      status: 'info',
      message: `Sleep today: ${todaySleepHrs.toFixed(1)}h across ${summary.sleepEnds} completed naps.`,
    });
  }

  // Diapers
  if (summary.diapers > 0) {
    insights.push({
      category: 'diapers',
      status: 'info',
      message: `Diapers today: ${summary.diapers}.`,
    });
  }

  // Tummy time
  const ageDays = getBabyAgeDays();
  if (ageDays !== null && ageDays >= 7) {
    const todayEnd = new Date();
    const tt = getTummyTimeTotal(chatJid, todayStart.toISOString(), todayEnd.toISOString());
    if (tt.totalMinutes > 0) {
      insights.push({
        category: 'tummy_time',
        status: 'info',
        message: `Tummy time today: ${tt.totalMinutes} min across ${tt.count} sessions.`,
      });
    }
  }

  // Feed rhythm from baby's own data
  const feedTimes = getBabyEventTimes(chatJid, 'feed', 20);
  if (feedTimes.length >= 5) {
    const intervals: number[] = [];
    for (let i = 1; i < feedTimes.length; i++) {
      intervals.push((Date.parse(feedTimes[i]) - Date.parse(feedTimes[i - 1])) / 60000);
    }
    const sorted = [...intervals].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];

    insights.push({
      category: 'feeding',
      status: 'info',
      message: `Recent feed rhythm: every ~${Math.round(med)} min (median of last ${feedTimes.length} feeds).`,
    });
  }

  return insights;
}

/**
 * Format observational stats as a human-readable message.
 */
export function formatAgeInsights(chatJid: string): string {
  const insights = getAgeBasedInsights(chatJid);
  if (insights.length === 0) {
    return 'No data to summarize yet. Log some events first.';
  }

  const lines = ["Today's stats:"];
  for (const insight of insights) {
    lines.push(`- ${insight.message}`);
  }

  return lines.join('\n');
}
