//! The instant arithmetic the usage rules are written in: ECMAScript's `Date` parse, its
//! `toISOString` and the epoch-seconds conversion Effect puts in front of them.
//!
//! Three properties of the shipped code make this tractable to port, and all three are
//! measured by `apps/server/scripts/usage-limits-trace.ts` rather than assumed:
//!
//! - **No local time zone is ever consulted.** Effect's `DateTime.make` appends `"Z"` to any
//!   string whose text does not already look zoned, and `DateTime.formatIso` always formats
//!   in UTC, so a reset time survives three time zones of regeneration unchanged. This port
//!   has no notion of a local zone either, which is therefore not a gap.
//! - **Only the instant matters.** Both callers discard everything but the resulting epoch,
//!   so a parse that V8 accepts and this one does not shows up as a missing bar rather than a
//!   wrong one.
//! - **The inputs are machine-written.** A `resets_at` arrives from the Claude CLI as
//!   ISO 8601 and a Codex reset arrives as epoch seconds. The legacy shapes V8 also accepts
//!   (`05/01/2026 12:00:00`, `Thu, 01 May 2026 12:00:00 GMT`) are ported because they are
//!   cheap and measured, not because anything sends them.
//!
//! Where this parser and V8 can still disagree is stated in [`date_parse`]'s doc comment.

use std::cmp::Ordering;

/// The largest epoch milliseconds a `Date` can hold: ±100 000 000 days.
const MAX_EPOCH_MS: f64 = 8.64e15;

/// ECMAScript's `WhiteSpace ∪ LineTerminator`, which is what `Date.parse` skips at the
/// ends of its input. Same two deviations from Unicode whitespace the PTY port records:
/// U+FEFF is trimmed, U+0085 is not.
fn is_js_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
}

/// ECMAScript's `TrimString`, shared with `read`'s `Number(text)`, which trims the same set.
pub(crate) fn trim_js(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
        .trim_end_matches(is_js_whitespace)
}

/// Leading whitespace only, because a space is also the date/time separator and the caller
/// has to see it.
fn skip_spaces(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// Effect's `hasZone` test — `/Z|GMT|[+-]\d{2}$|[+-]\d{2}:?\d{2}$|\]$/`, unanchored except
/// where it says `$`. A `Z` anywhere counts, so `2026-05-01T12:00:00Z[Europe/Berlin]` is
/// "zoned" to this test even though nothing can parse it.
fn has_zone(text: &str) -> bool {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let digits = |end: usize, count: usize| -> bool {
        end >= count && (end - count..end).all(|index| bytes[index].is_ascii_digit())
    };
    let sign = |index: usize| matches!(bytes.get(index), Some(&b'+') | Some(&b'-'));
    text.contains('Z')
        || text.contains("GMT")
        // `[+-]\d{2}$`, as in `…T12:00:00+02`.
        || (len >= 3 && sign(len - 3) && digits(len, 2))
        // `[+-]\d{2}\d{2}$`, the `:?` absent, as in `…-0330`.
        || (len >= 5 && sign(len - 5) && digits(len - 2, 2) && digits(len, 2))
        // `[+-]\d{2}:\d{2}$`, as in `…+02:00`.
        || (len >= 6
            && sign(len - 6)
            && digits(len - 3, 2)
            && bytes[len - 3] == b':'
            && digits(len, 2))
        || bytes.last() == Some(&b']')
}

/// `DateTime.make(input)` for a string, then `DateTime.formatIso`: parse with Effect's
/// `"Z"` rule applied first, and format the instant in UTC. `None` is Effect's `none`, which
/// the shipped mappers turn into "this row has no reset time".
pub fn iso_from_string(input: &str) -> Option<String> {
    let zoned = if has_zone(input) {
        input.to_owned()
    } else {
        format!("{input}Z")
    };
    to_iso_string(date_parse(&zoned)?)
}

/// The shipped `isoFromEpochSeconds` guards: `Number.isFinite(value) && value > 0`. Zero and
/// negatives are rejected before any calendar work, so a reset "at the epoch" reads as
/// absent rather than as 1970.
pub fn iso_from_epoch_seconds(seconds: f64) -> Option<String> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    to_iso_string(millis_from_seconds(seconds))
}

/// `new Date(value * 1000)` for a number: the product is clipped to the range a `Date`
/// holds and truncated toward zero, so 2^53 seconds — a value a JSON number can carry —
/// is an invalid date rather than a year-285618 one.
fn millis_from_seconds(seconds: f64) -> f64 {
    let millis = seconds * 1000.0;
    if !millis.is_finite() || millis.abs() > MAX_EPOCH_MS {
        return f64::NAN;
    }
    millis.trunc()
}

/// `date.toISOString()`, or `None` for an invalid date. Years outside 0..=9999 switch to
/// the expanded `±YYYYYY` spelling, which is why a reset in year 1 reads
/// `-000001-01-01T00:00:00.000Z`.
#[must_use]
pub fn to_iso_string(millis: f64) -> Option<String> {
    if !millis.is_finite() || millis.abs() > MAX_EPOCH_MS {
        return None;
    }
    let millis = millis.trunc();
    let days = millis.div_euclid(86_400_000.0);
    let time_of_day = millis.rem_euclid(86_400_000.0);
    let (year, month, day) = civil_from_days(days as i64);
    let hour = (time_of_day / 3_600_000.0) as u32;
    let minute = (time_of_day % 3_600_000.0 / 60_000.0) as u32;
    let second = (time_of_day % 60_000.0 / 1000.0) as u32;
    let fraction = (time_of_day % 1000.0) as u32;
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:03}Z"
    ))
}

/// `Date.parse`, restricted as its doc comment states. `None` is an invalid date, which the
/// callers see as `NaN`.
///
/// Accepted, each case measured against the shipped code:
///
/// - The ISO 8601 date-time grammar: `±YYYYYY` years, a month or day written with one digit
///   (`2026-1-1`), a bare year or year-month (`2026` and `2026-05` both land on the first),
///   `T`/`t`/a space before the time, `Z`/`z`/`±HH:mm`/`±HHmm` offsets, a fractional second
///   of any digit count truncated to milliseconds (`.9999` is `.999`), `hh:mm` without
///   seconds, the `24:00:00.000` end-of-day form, padding ECMAScript whitespace anywhere the
///   text is already loose, and out-of-range days rolling over (`2026-02-30` is March 2,
///   because only the month and the time fields are range-checked).
/// - `MM/DD/YYYY [HH:MM:SS]` and `Wdy, DD Mon YYYY HH:MM:SS <zone>` — V8's legacy forms.
///
/// Rejected, matching what the trace shows V8 doing: a two-digit year, an offset written
/// `+02`, a bare zone name (`2026-05-01T12:00:00GMT`), a zone name after a space
/// (`2026-05-01T12:00:00 UTC`), a bracketed IANA name, month 13, minute 60, second 60, and
/// any padding around the `T` form — `2026-05-08T00:00:00Z ` is refused outright.
///
/// One difference remains, and the golden does not carry it: a date-only text with *leading*
/// padding (`" 2026-05-08"`) lands on UTC here, while the shipped code answers it in the host's
/// zone — Effect appends its `"Z"` to the padded text, and V8's legacy parser then reads
/// ` 2026-05-08Z` as a legacy date rather than a zoned one. That answer changes with the
/// machine, so `apps/server/scripts/usage-limits-trace.ts` leaves the spelling out rather than
/// recording an instant no other host agrees to.
#[must_use]
pub fn date_parse(text: &str) -> Option<f64> {
    let trimmed = trim_js(text);
    if trimmed.is_empty() {
        return None;
    }
    iso_date_parse(trimmed, text.len() != trimmed.len()).or_else(|| legacy_date_parse(trimmed))
}

/// Fields an accepted string resolved to, before the calendar arithmetic.
#[derive(Clone, Copy, Debug)]
struct ParsedDate {
    year: i64,
    /// 1-based.
    month: i64,
    /// 1-based; a date written without one lands on the first.
    day: i64,
    hour: f64,
    minute: f64,
    second: f64,
    millis: f64,
}

impl ParsedDate {
    fn at_midnight(year: i64, month: i64, day: i64) -> Self {
        Self {
            year,
            month,
            day,
            hour: 0.0,
            minute: 0.0,
            second: 0.0,
            millis: 0.0,
        }
    }

    fn set_time(&mut self, time: ClockTime) {
        self.hour = time.hour;
        self.minute = time.minute;
        self.second = time.second;
        self.millis = time.millis;
    }

    /// `MakeDay` then `MakeTime`, with `TimeClip`'s range check on the sum.
    fn to_epoch_millis(self) -> Option<f64> {
        if !(1..=12).contains(&self.month) {
            return None;
        }
        let days = days_from_civil(self.year, self.month, self.day);
        let time = ((self.hour * 60.0 + self.minute) * 60.0 + self.second) * 1000.0 + self.millis;
        let millis = days as f64 * 86_400_000.0 + time;
        if millis.is_finite() && millis.abs() <= MAX_EPOCH_MS {
            Some(millis)
        } else {
            None
        }
    }
}

/// ECMAScript's `MakeDay(year, month, date)` for an in-range month: `tm::days_from_civil`
/// with the epoch moved to 1970. An out-of-range `date` is not an error: it rolls over,
/// which is why February 30 is March 2.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The inverse, for `toISOString`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let zeroed = days + 719_468;
    let era = zeroed.div_euclid(146_097);
    let day_of_era = zeroed - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `hh:mm[:ss[.fraction]]`. `24:00:00.000` is the end of the previous day; any other field
/// at 24 hours is rejected the way the specification's `Date From Time String` does.
#[derive(Clone, Copy, Debug)]
struct ClockTime {
    hour: f64,
    minute: f64,
    second: f64,
    millis: f64,
}

fn iso_date_parse(text: &str, padded: bool) -> Option<f64> {
    let (year, rest) = read_year(text)?;
    let mut parsed = ParsedDate::at_midnight(year, 1, 1);

    // Month and day. A single digit is allowed here and nowhere else in the grammar.
    let mut rest = rest;
    if let Some(after_year) = rest.strip_prefix('-') {
        let (month, after_month) = read_number(after_year, 1, 2)?;
        parsed.month = month;
        rest = if let Some(after_day) = after_month.strip_prefix('-') {
            let (day, after_day) = read_number(after_day, 1, 2)?;
            parsed.day = day;
            after_day
        } else {
            after_month
        };
    }

    // `T` demands a time; a space is the time separator but may also be trailing padding,
    // which is why `"2026-05-01 "` and `"2026-05-01Z"` are both the bare date.
    let (requires_time, mut rest) = match rest.as_bytes().first() {
        Some(b'T') | Some(b't') => (true, skip_spaces(&rest[1..])),
        Some(b' ') => (false, skip_spaces(rest)),
        _ => (false, rest),
    };
    if requires_time || rest.as_bytes().first().is_some_and(u8::is_ascii_digit) {
        let (time, tail) = read_time(rest)?;
        // The `T` spelling is the one the engines treat as the strict ISO form: nothing may pad
        // it and its zone has to be attached, which is why `2026-05-08T00:00:00 ` is refused
        // while `2026-05-08 ` and `2026-05-08 00:00:00 ` are not. The padding has to be judged
        // from the caller's text, since [`date_parse`] has already trimmed it away.
        if requires_time && (padded || tail.chars().next().is_some_and(is_js_whitespace)) {
            return None;
        }
        parsed.set_time(time);
        rest = skip_spaces(tail);
    }
    let offset_millis = if rest.is_empty() {
        0.0
    } else {
        read_zone(rest)?
    };
    Some(parsed.to_epoch_millis()? - offset_millis)
}

/// `YYYY`, or `±YYYYYY` for the years the four-digit form cannot hold.
fn read_year(text: &str) -> Option<(i64, &str)> {
    let (negative, digits) = match text.as_bytes().first()? {
        b'+' => (false, &text[1..]),
        b'-' => (true, &text[1..]),
        _ => (false, text),
    };
    let count = digits
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(digits.len());
    if count != if text.len() == digits.len() { 4 } else { 6 } {
        return None;
    }
    let value: i64 = digits[..count].parse().ok()?;
    Some((if negative { -value } else { value }, &digits[count..]))
}

/// Between `min` and `max` digits, so a field can be greedy where the grammar allows it.
fn read_number(text: &str, min: usize, max: usize) -> Option<(i64, &str)> {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits < min || digits > max {
        return None;
    }
    let value: i64 = text[..digits].parse().ok()?;
    Some((value, &text[digits..]))
}

fn read_time(text: &str) -> Option<(ClockTime, &str)> {
    let (hour, rest) = read_number(text, 2, 2)?;
    let rest = rest.strip_prefix(':')?;
    let (minute, rest) = read_number(rest, 2, 2)?;
    let (second, mut rest) = match rest.strip_prefix(':') {
        Some(after_minutes) => {
            let (second, after_seconds) = read_number(after_minutes, 2, 2)?;
            (second, after_seconds)
        }
        None => (0, rest),
    };
    let mut millis = 0.0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        // Longer than three digits is truncated, not rounded, and the rest is not re-read.
        let taken = &fraction[..digits.min(3)];
        millis = taken.parse::<f64>().ok()? * 10f64.powi(3 - taken.len() as i32);
        rest = &fraction[digits..];
    }
    if hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && (minute, second, millis) != (0, 0, 0.0) {
        return None;
    }
    Some((
        ClockTime {
            hour: hour as f64,
            minute: minute as f64,
            second: second as f64,
            millis,
        },
        rest,
    ))
}

/// `Z`, `z`, or `±HH:mm` / `±HHmm`, as the milliseconds a wall clock is *ahead* of UTC — so
/// a caller subtracts them. A bare name is not a zone here, which is what makes
/// `2026-05-01T12:00:00GMT` invalid in both engines.
fn read_zone(text: &str) -> Option<f64> {
    let sign = match text.as_bytes().first()? {
        b'Z' | b'z' if text.len() == 1 => return Some(0.0),
        b'+' => 1.0,
        b'-' => -1.0,
        _ => return None,
    };
    let digits = &text[1..];
    let (hours, minutes) = match digits.as_bytes().get(2) {
        Some(b':') if digits.len() == 5 => (read_two(digits, 0)?, read_two(digits, 3)?),
        _ if digits.len() == 4 => (read_two(digits, 0)?, read_two(digits, 2)?),
        _ => return None,
    };
    if hours > 23.0 || minutes > 59.0 {
        return None;
    }
    Some(sign * (hours * 60.0 + minutes) * 60_000.0)
}

fn read_two(text: &str, offset: usize) -> Option<f64> {
    text.get(offset..offset + 2)?.parse().ok()
}

fn legacy_date_parse(text: &str) -> Option<f64> {
    us_date_parse(text).or_else(|| rfc1123_parse(text))
}

/// `MM/DD/YYYY[, HH:MM:SS]` with an optional trailing UTC zone. V8 also swaps day and month
/// for two-digit years, which the port does not attempt.
fn us_date_parse(text: &str) -> Option<f64> {
    let (month, rest) = read_number(text, 1, 2)?;
    let rest = rest.strip_prefix('/')?;
    let (day, rest) = read_number(rest, 1, 2)?;
    let rest = rest.strip_prefix('/')?;
    let (year, rest) = read_number(rest, 1, 4)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut parsed = ParsedDate::at_midnight(year, month, day);
    let rest = skip_spaces(rest);
    if rest.is_empty() {
        return parsed.to_epoch_millis();
    }
    if !rest.as_bytes().first().is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let (time, rest) = read_time(rest)?;
    parsed.set_time(time);
    let zone = match skip_spaces(rest) {
        "" => 0.0,
        // V8 reads a trailing `GMT`/`UTC` here; anything else needs the host's answer.
        "GMT" | "UTC" | "Z" => 0.0,
        rest => read_zone(rest)?,
    };
    Some(parsed.to_epoch_millis()? - zone)
}

/// `Thu, 01 May 2026 12:00:00 GMT`, with the weekday optional and the zone limited to the
/// names that mean UTC.
fn rfc1123_parse(text: &str) -> Option<f64> {
    let tokens: Vec<&str> = text
        .split([' ', '\t', ','])
        .filter(|token| !token.is_empty())
        .collect();
    // `Wdy DD Mon YYYY HH:MM:SS GMT`, or the same without the leading weekday.
    let offset = match tokens.len() {
        6 => 1,
        5 => 0,
        _ => return None,
    };
    let day: i64 = tokens[offset].parse().ok()?;
    let month = match tokens[offset + 1].to_ascii_lowercase().as_str() {
        "jan" | "january" => 1,
        "feb" | "february" => 2,
        "mar" | "march" => 3,
        "apr" | "april" => 4,
        "may" => 5,
        "jun" | "june" => 6,
        "jul" | "july" => 7,
        "aug" | "august" => 8,
        "sep" | "september" => 9,
        "oct" | "october" => 10,
        "nov" | "november" => 11,
        "dec" | "december" => 12,
        _ => return None,
    };
    let year: i64 = tokens[offset + 2].parse().ok()?;
    let (time, _) = read_time(tokens[offset + 3])?;
    let zone_name = tokens
        .get(offset + 4)
        .map_or_else(|| "UTC".to_owned(), |name| name.to_ascii_uppercase());
    let zone = match zone_name.as_str() {
        "GMT" | "UTC" | "Z" | "ZULU" => 0.0,
        // `EST` and the other abbreviations whose answer is the host's, and any offset
        // spelling, are outside what the shipped callers can receive.
        _ => return None,
    };
    if !(1..=31).contains(&day) {
        return None;
    }
    let mut parsed = ParsedDate::at_midnight(year, month, day);
    parsed.set_time(time);
    Some(parsed.to_epoch_millis()? - zone)
}

/// The comparison `sortWindows` leans on: `String.prototype.localeCompare` with no options,
/// which is the runtime's default CLDR collation, not a byte order.
///
/// Measured against the shipped code, the order it gives for the characters a usage window
/// id can hold is: ECMAScript punctuation before digits before letters, the punctuation
/// among themselves in CLDR root order, letters ignoring case, and lowercase before
/// uppercase only as the last tie-break. That differs from `str::cmp` in two places that
/// are reachable: `_` sorts *before* digits and letters rather than between them, so
/// `seven_day_gpt_5` precedes `seven_day_gpt5`, and `five_hour` precedes `fivehour`.
///
/// Non-ASCII is outside the table: every id the shipped mappers can build is either a
/// literal in `[a-z0-9_]` or a Claude display name that `scopedWindowId` has already
/// reduced to it, and the golden's id tables stay inside that alphabet.
#[must_use]
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    let (left_primary, left_case) = collation_keys(left);
    let (right_primary, right_case) = collation_keys(right);
    for index in 0..left_primary.len().min(right_primary.len()) {
        match left_primary[index].cmp(&right_primary[index]) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    match left_primary.len().cmp(&right_primary.len()) {
        Ordering::Equal => {}
        other => return other,
    }
    for index in 0..left_case.len().min(right_case.len()) {
        match left_case[index].cmp(&right_case[index]) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    Ordering::Equal
}

/// The measured primary order: punctuation (root-collation order), digits, letters.
const PRIMARY_ORDER: &str =
    " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

fn collation_keys(text: &str) -> (Vec<u32>, Vec<u8>) {
    let mut primary = Vec::with_capacity(text.len());
    let mut case = Vec::with_capacity(text.len());
    for character in text.chars() {
        let rank = PRIMARY_ORDER
            .chars()
            .position(|candidate| candidate.eq_ignore_ascii_case(&character))
            .map_or_else(
                || 1_000_000 + u32::from(character),
                |index| index as u32 + 1,
            );
        primary.push(rank);
        case.push(if character.is_ascii_uppercase() { 2 } else { 1 });
    }
    (primary, case)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_from_string_applies_the_effect_z_rule_and_formats_in_utc() {
        assert_eq!(
            iso_from_string("2026-05-01T12:00:00").as_deref(),
            Some("2026-05-01T12:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("2026-05-01T12:00:00+02:00").as_deref(),
            Some("2026-05-01T10:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("2026-05-01").as_deref(),
            Some("2026-05-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("2026-05").as_deref(),
            Some("2026-05-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("2026").as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("2026-05-01T12:00").as_deref(),
            Some("2026-05-01T12:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("2026-05-01T12:00:00Z").as_deref(),
            Some("2026-05-01T12:00:00.000Z")
        );
        // A trailing space is the date/time separator with nothing after it, which the golden
        // measures as the bare date. Padding around an already-zoned string is not measured —
        // V8 rejects it and this parser trims it — because no caller can produce it.
        assert_eq!(
            iso_from_string("2026-05-01 ").as_deref(),
            Some("2026-05-01T00:00:00.000Z")
        );
        assert_eq!(iso_from_string("").as_deref(), None);
        assert_eq!(iso_from_string(" ").as_deref(), None);
    }

    #[test]
    fn a_fraction_is_truncated_and_a_day_rolls_over() {
        assert_eq!(
            iso_from_string("2026-05-01T12:00:00.9999Z").as_deref(),
            Some("2026-05-01T12:00:00.999Z")
        );
        assert_eq!(
            iso_from_string("2026-05-01T12:00:00.5Z").as_deref(),
            Some("2026-05-01T12:00:00.500Z")
        );
        assert_eq!(
            iso_from_string("2026-02-30T00:00:00Z").as_deref(),
            Some("2026-03-02T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("2026-05-01T24:00:00.000Z").as_deref(),
            Some("2026-05-02T00:00:00.000Z")
        );
        assert_eq!(iso_from_string("2026-05-01T24:00:01.000Z"), None);
    }

    #[test]
    fn the_rejections_match_what_v8_answers() {
        for text in [
            "26-05-01",
            "2026-05-01T12:00:00+02",
            "2026-05-01T12:00:00GMT",
            "2026-05-01T12:00:00 UTC",
            "2026-05-01T12:00:00[Europe/Berlin]",
            "2026-13-01T00:00:00Z",
            "2026-05-01T12:60:00Z",
            "2026-05-01T12:00:60Z",
            "not a date",
        ] {
            assert_eq!(iso_from_string(text), None, "{text} should not parse");
        }
    }

    #[test]
    fn the_legacy_forms_parse_too_and_the_expanded_year_round_trips() {
        assert_eq!(
            date_parse("05/01/2026 12:00:00")
                .and_then(to_iso_string)
                .as_deref(),
            Some("2026-05-01T12:00:00.000Z")
        );
        assert_eq!(
            date_parse("Thu, 01 May 2026 12:00:00 GMT")
                .and_then(to_iso_string)
                .as_deref(),
            Some("2026-05-01T12:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("-000001-01-01T00:00:00Z").as_deref(),
            Some("-000001-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso_from_string("+010000-01-01T00:00:00Z").as_deref(),
            Some("+010000-01-01T00:00:00.000Z")
        );
        // Past the ±100 000 000 day range a `Date` cannot go.
        assert_eq!(date_parse("+275761-01-01T00:00:00Z"), None);
    }

    #[test]
    fn epoch_seconds_are_guarded_before_any_calendar_work() {
        assert_eq!(
            iso_from_epoch_seconds(1_777_000_000.0).as_deref(),
            Some("2026-04-24T03:06:40.000Z")
        );
        // A sub-second reset still lands on the millisecond the product carries.
        assert_eq!(
            iso_from_epoch_seconds(1_777_000_000.5).as_deref(),
            Some("2026-04-24T03:06:40.500Z")
        );
        for seconds in [0.0, -1.0, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
            assert_eq!(
                iso_from_epoch_seconds(seconds),
                None,
                "{seconds} should read as absent"
            );
        }
    }

    #[test]
    fn locale_compare_sorts_punctuation_before_letters_not_like_bytes() {
        assert_eq!(locale_compare("a.b", "ab"), Ordering::Less);
        assert_eq!(locale_compare("five_hour", "fivehour"), Ordering::Less);
        // The byte order puts `_` (0x5F) after every digit, so a byte sort would rank the
        // model's weekly bar before the same model's overage-included one.
        assert_eq!("seven_day_gpt_5".cmp("seven_day_gpt5"), Ordering::Greater);
        assert_eq!(
            locale_compare("seven_day_gpt_5", "seven_day_gpt5"),
            Ordering::Less
        );
        assert_eq!(locale_compare("cap", "Cap"), Ordering::Less);
        assert_eq!(locale_compare("Cap", "CAP"), Ordering::Less);
        assert_eq!(locale_compare("five_hour", "five_hour"), Ordering::Equal);
        assert_eq!(locale_compare("weekly", "five_hour"), Ordering::Greater);
    }
}
