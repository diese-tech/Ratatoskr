import * as chrono from 'chrono-node';

export type ScoutStartTimeResult =
  | { ok: true; startAt: number }
  | { ok: false; reason: 'unparseable' | 'in_past'; message: string };

function timezoneOffsetMinutes(timezone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value])) as Record<
    string,
    string
  >;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export function parseScoutStartTime(
  input: string,
  timezone: string,
  now: Date = new Date(),
): ScoutStartTimeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: 'unparseable',
      message: 'Enter a start time such as `tonight at 8` or `Friday 9:30pm`.',
    };
  }

  const referenceOffset = timezoneOffsetMinutes(timezone, now);
  const parsed = chrono.parse(trimmed, { instant: now, timezone: referenceOffset }, { forwardDate: true });
  const first = parsed[0];
  if (!first) {
    return {
      ok: false,
      reason: 'unparseable',
      message: `Couldn't read \`${trimmed}\` as a time. Try \`tonight at 8\`, \`tomorrow 7pm\`, or \`9/5 at 6pm\`.`,
    };
  }

  const tentative = first.date();
  const usedExplicitOffset = first.start.get('timezoneOffset') !== null;
  const date = usedExplicitOffset
    ? tentative
    : (() => {
        const correctedOffset = timezoneOffsetMinutes(timezone, tentative);
        const localWallClockMs = Date.UTC(
          first.start.get('year')!,
          first.start.get('month')! - 1,
          first.start.get('day')!,
          first.start.get('hour') ?? 0,
          first.start.get('minute') ?? 0,
          first.start.get('second') ?? 0,
        );
        return new Date(localWallClockMs - correctedOffset * 60_000);
      })();

  if (date.getTime() <= now.getTime()) {
    return {
      ok: false,
      reason: 'in_past',
      message: `\`${trimmed}\` resolves to a time that has already passed. Enter a future time.`,
    };
  }
  return { ok: true, startAt: Math.floor(date.getTime() / 1_000) };
}
