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
//! Where this parser and V8 can still disagree is stated in [`date_parse`]'s doc comment, and
//! every such case is outside what the shipped adapters produce.

use std::cmp::Ordering;

/// The largest epoch milliseconds a `Date` can hold: ±100 000 000 days.
const MAX_EPOCH_MS: f64 = 8.64e15;

/// ECMAScript's `WhiteSpace ∪ LineTerminator`, which is what `Date.parse` skips at the
/// ends of its input. Same two deviations from Unicode whitespace the PTY port records:
/// U+FEFF is trimmed, U+0085 is not.
fn is_js_whitespace(character: char) -> bool {
    character == '\u{feff}' || (character.is_whitespace() && character != '\u{85}')
}

fn trim_js(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Effect's `hasZone` test — `/Z|GMT|[+-]\d{2}$|[+-]\d{2}:?\d{2}$|\]$/`, unanchored except
/// where it says `$`. A `Z` anywhere counts, so `2026-05-01T12:00:00Z[Europe/Berlin]` is
/// "zoned" to this test even though nothing can parse it.
fn has_zone(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits_before = |end: usize, count: usize| -> bool {
        end >= count
            && (end - count..end).all(|index| bytes[index].is_ascii_digit())
    };
    text.contains('Z')
        || text.contains("GMT")
        || (bytes.len() >= 3
            && (bytes[bytes.len() - 3] == b'+' || bytes[bytes.len() - 3] == b'-')
            && digits_before(bytes.len() - 1, 2))
        || matches!(bytes.len(), len if len >= 5
            && (bytes[len - 5] == b'+' || bytes[len - 5] == b'-')
            && digits_before(len - 3, 2)
            && digits_before(len, 2))
        || matches!(bytes.len(), len if len >= 6
            && (bytes[len - 5] == b'+' || bytes[len - 5] == b'-')
            && bytes[len - 3] == b':'
            && digits_before(len - 2, 2)
            && digits_before(len, 2))
        || bytes.last() == Some(&b']')
}

/// `DateTime.make(input)` for a string, then `DateTime.formatIso`: parse with Effect's
/// `"Z"` rule applied first, and format the instant in UTC. `None` is `undefined`.
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
pub fn millis_from_seconds(seconds: f64) -> f64 {
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

/// `Date.parse`, restricted as its doc comment states. `None` is an invalid date; the
/// `Number` a caller compares against is `NaN` there.
///
/// Accepted, all measured against the shipped code:
///
/// - The ISO 8601 date-time grammar, including `±YYYYYY` years, a `Z` or `±HH:mm`/`±HHmm`
///   offset, a fractional second of any digit count (truncated to milliseconds, so `.9999`
///   is `.999`), the `24:00:00.000` end-of-day form, and out-of-range days rolling over
///   (`2026-02-30` is March 2, because only the month and the time fields are range-checked).
/// - Month and day written with one digit (`2026-1-1`), a space instead of `T`, a leading or
///   trailing run of ECMAScript whitespace, and a bare year or year-month.
/// - `MM/DD/YYYY [HH:MM:SS]` and `Wdy, DD Mon YYYY HH:MM:SS <zone>` — V8's legacy forms.
///
/// Deliberately not accepted, each because nothing in the shipped adapters can send it:
/// a zone-less *date-time* (this port reads it as UTC, where V8 would read local time —
/// unreachable through Effect, which appends `"Z"` first); a bare named zone such as
/// `12:00:00 UTC` or a military zone letter; `hh:mm` without seconds followed by a zone
/// name; and a two-digit year.
#[must_use]
pub fn date_parse(text: &str) -> Option<f64> {
    let text = trim_js(text);
    if text.is_empty() {
        return None;
    }
    iso_date_parse(text).or_else(|| legacy_date_parse(text))
}

/// Fields an accepted string resolved to, before the calendar arithmetic.
#[derive(Clone, Copy, Debug)]
struct ParsedDate {
    year: i64,
    /// 1-based, as written.
    month: i64,
    /// 1-based, or 0 when the string carried no day.
    day: i64,
    hour: f64,
    minute: f64,
    second: f64,
    millis: f64,
    /// `Some(false)` for a zone-less *date* form, which ECMAScript reads as UTC; the flag
    /// exists to make the date-time branch state its own choice out loud.
    zoned: bool,
}

impl ParsedDate {
    fn at_midnight(year: i64, month: i64, day: i64, zoned: bool) -> Self {
        Self { year, month, day, hour: 0.0, minute: 0.0, second: 0.0, millis: 0.0, zoned }
    }

    /// `MakeDate` then `MakeTime`, with the ±100 000 000 day clip.
    fn to_epoch_millis(self) -> Option<f64> {
        let month = self.month - 1;
        // A day the caller never wrote (`2026-05`) still has to land on the first.
        let day = if self.day == 0 { 1 } else { self.day };
        if !(1..=12).contains(&self.month) {
            return None;
        }
        // `MakeDate`'s year/month normalisation, and the `TimeClip` range check on the sum.
        let (year, month) = euclid_div_mod_i64(self.year, 12) ;
        let month_index = euclid_sub(month, 1) + euclid_mul(year, 12);
        let days = days_from_civil(euclid_add(year, 1970), month_index, day);
        if !(-337_200_000_000_000.0..=337_200_000_000_000.0).contains(&(days as f64)) {
            return None;
        }
        let time = ((self.hour * 60.0 + self.minute) * 60.0 + self.second) * 1000.0 + self.millis;
        let millis = days as f64 * 86_400_000.0 + time;
        if millis.is_finite() && millis.abs() <= MAX_EPOCH_MS {
            Some(millis)
        } else {
            None
        }
    }
}

fn euclid_div_mod_i64(value: i64, divisor: i64) -> (i64, i64) {
    (value.div_euclid(divisor), value.rem_euclid(divisor))
}

fn euclid_sub(left: i64, right: i64) -> i64 {
    left.wrapping_sub(right)
}

fn euclid_mul(left: i64, right: i64) -> i64 {
    left.wrapping_mul(right)
}

fn euclid_add(left: i64, right: i64) -> i64 {
    left.wrapping_add(right)
}

/// ECMAScript's `MakeDay`, which is `tm::days_from_civil` with the epoch moved to 1970.
/// An out-of-range `day` is not an error: it rolls over, which is why February 30 is March 2.
fn days_from_civil(year: i64, month_zero_based: i64, day: i64) -> i64 {
    let shifted_year = if month_zero_based <= 2 {
        year - 1
    } else {
        year
    };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let shifted_month = (month_zero_based + 9).rem_euclid(12);
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
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

fn iso_date_parse(text: &str) -> Option<f64> {
    let rest = text;
    let (year, rest) = read_year(rest)?;
    let mut parsed = ParsedDate::at_midnight(year, 1, 0, false);

    // Month and day. A single digit is allowed here and nowhere else in the grammar.
    let rest = rest.strip_prefix('-')?;
    let (month, rest) = read_number(rest, 1, 2)?;
    parsed.month = month;
    let mut rest = rest;
    if let Some(after_day) = rest.strip_prefix('-') {
        let (day, after_day) = read_number(after_day, 1, 2)?;
        parsed.day = day;
        rest = after_day;
    } else {
        parsed.day = 1;
    }

    rest = skip_spaces(rest);
    if rest.is_empty() {
        // Zone-less date form: UTC by the specification, and the only case of its kind the
        // port keeps, because a reset written as a bare date is unambiguous.
        return parsed.to_epoch_millis();
    }

    let (zoneless_time, rest) = if let Some(rest) = rest
        .strip_prefix('T')
        .or_else(|| rest.strip_prefix('t'))
        .or_else(|| rest.strip_prefix(' '))
    {
        let (time, rest) = read_time(skip_spaces(rest))?;
        parsed.hour = time.0;
        parsed.minute = time.1;
        parsed.second = time.2;
        parsed.millis = time.3;
        (true, skip_spaces(rest))
    } else {
        (false, rest)
    };

    let offset = if zoneless_time && rest.is_empty() {
        None
    } else {
        Some(read_zone(rest?)?)
    };
    let millis = parsed.to_epoch_millis()?;
    Some(match offset {
        Some(offset_millis) => millis - offset_millis,
        None => millis,
    })
}

fn read_year(text: &str) -> Option<(i64, &str)> {
    let (sign, digits) = match text.as_bytes().first()? {
        b'+' => (1, &text[1..]),
        b'-' => (-1, &text[1..]),
        _ => (1, text),
    };
    let digit_count = digits
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(digits.len());
    if digit_count != 4 && !(digit_count == 6 && sign != 1 || digit_count == 6 && text.starts_with('+'))
    {
        return None;
    }
    let value: i64 = digits[..digit_count].parse().ok()?;
    Some((sign * value, &digits[digit_count..]))
}

/// Exactly `count` digits, or between `min` and `max` when `count` is a range.
fn read_number(text: &str, min: usize, max: usize) -> Option<(i64, &str)> {
    let digits = text.bytes().take_while(|byte| byte.is_ascii_digit()).count();
    if digits < min || digits > max {
        return None;
    }
    let value: i64 = text[..digits].parse().ok()?;
    Some((value, &text[digits..]))
}

fn skip_spaces(text: &str) -> &str {
    let trimmed = trim_js(text);
    // A space is also the date/time separator, so only leading whitespace is removed here.
    if text.starts_with(is_js_whitespace) {
        trimmed_start(text)
    } else {
        trimmed
    }
}

fn trimmed_start(text: &str) -> &str {
    let mut offset = 0;
    for character in text.chars() {
        if !is_js_whitespace(character) {
            break;
        }
        offset += character.len_utf8();
    }
    &text[offset..]
}

/// `HH:MM[:SS[.fraction]]`. `24:00:00.000` is the end of the previous day; any other field
/// at 24 hours, and a second of 60 outside a whole minute, are rejected the way the
/// specification's `Date From Time` does.
fn read_time(text: &str) -> Option<((f64, f64, f64, f64), &str)> {
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
        let digits = fraction.bytes().take_while(|byte| byte.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let taken: String = fraction.chars().take(3).collect();
        millis = taken
            .parse::<f64>()
            .ok()
            .map(|value| value * 10f64.powi(3 - taken.len() as i32))
            .unwrap_or(f64::NAN);
        rest = &fraction[digits..];
    }
    if hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if hour == 24 && !(minute == 0 && second == 0 && millis == 0.0) {
        return None;
    }
    Some(((hour as f64, minute as f64, second as f64, millis), rest))
}

/// `Z`, `z`, or `±HH:mm` / `±HHmm`. A bare name is not a zone here, which is what makes
/// `2026-05-01T12:00:00GMT` invalid in both engines.
fn read_zone(text: &str) -> Option<f64> {
    if text.is_empty() {
        return Some(0.0);
    }
    let mut chars = text.chars();
    match chars.next()? {
        'Z' | 'z' if text.len() == 1 => Some(0.0),
        sign @ ('+' | '-') => {
            let digits = text[1..]
                .bytes()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            let (hours, minutes) = match digits {
                4 => (
                    text[1..3].parse::<f64>().ok()?,
                    text[3..5].parse::<f64>().ok()?,
                ),
                5 if text.as_bytes()[3] == b':' => (
                    text[1..3].parse::<f64>().ok()?,
                    text[4..6].parse::<f64>().ok()?,
                ),
                _ => return None,
            };
            if hours > 23 || minutes > 59 {
                return None;
            }
            let offset = (hours * 60.0 + minutes) * 60_000.0;
            Some(if sign == '-' { offset } else { -offset })
        }
        _ => None,
    }
}

fn legacy_date_parse(text: &str) -> Option<f64> {
    us_date_parse(text).or_else(|| rfc1123_parse(text))
}

/// `MM/DD/YYYY[, HH:MM:SS]` with an optional trailing zone token. V8 also swaps day and
/// month for two-digit years, which the port does not attempt.
fn us_date_parse(text: &str) -> Option<f64> {
    let (month, rest) = read_number(text, 1, 2)?;
    let rest = rest.strip_prefix('/')?;
    let (day, rest) = read_number(rest, 1, 2)?;
    let rest = rest.strip_prefix('/')?;
    let (year, rest) = read_number(rest, 1, 4)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut parsed = ParsedDate::at_midnight(year, month, day, true);
    let rest = skip_spaces(rest);
    let Some(first) = rest.chars().next() else {
        return parsed.to_epoch_millis();
    };
    if !first.is_ascii_digit() {
        return None;
    }
    let (time, rest) = read_time(rest)?;
    parsed.hour = time.0;
    parsed.minute = time.1;
    parsed.second = time.2;
    parsed.millis = time.3;
    let rest = skip_spaces(rest);
    let zone = read_zone(rest)?;
    Some(parsed.to_epoch_millis()? - zone)
}

/// `Thu, 01 May 2026 12:00:00 GMT`, with the weekday optional and the timezone limited to
/// the names that mean UTC. `EST` and friends would need the host's answer.
fn rfc1123_parse(text: &str) -> Option<f64> {
    let mut words = text.split(|character: char| character == ',' || is_js_whitespace(character));
    let first = words.next()?.trim();
    let (weekday_len, rest): (usize, &str) = if first.bytes().all(|byte| byte.is_ascii_alphabetic())
        && !first.is_empty()
        && first.len() <= 9
        && first.len() != 4
    {
        // A leading weekday: consume it along with its separating comma.
        (first.len() + 1, &text[first.len() + 1..])
    } else {
        (0, text)
    };
    debug_assert_eq!(weekday_len % 1, 0);
    let mut parts = rest
        .trim_start_matches(|character: char| character == ',' || is_js_whitespace(character))
        .split(is_js_whitespace);
    let day: i64 = parts.next()?.parse().ok()?;
    let month_name = parts.next()?;
    let month = match month_name.to_ascii_lowercase().as_str() {
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
    let year: i64 = parts.next()?.parse().ok()?;
    let (time, _) = read_time(parts.next()?)?;
    let zone_name = parts.next().unwrap_or("UTC");
    let zone = match zone_name.to_ascii_uppercase().as_str() {
        "GMT" | "UTC" | "Z" | "ZULU" => 0.0,
        _ if zone_name.starts_with('+') || zone_name.starts_with('-') => read_zone(zone_name)?,
        _ => return None,
    };
    if !(1..=31).contains(&day) {
        return None;
    }
    let mut parsed = ParsedDate::at_midnight(year, month, day, true);
    parsed.hour = time.0;
    parsed.minute = time.1;
    parsed.second = time.2;
    parsed.millis = time.3;
    Some(parsed.to_epoch_millis()? - zone)
}

/// The comparison `sortWindows` leans on: `String.prototype.localeCompare` with no options,
/// which is the runtime's default CLDR collation, not a byte order.
///
/// Measured against the shipped code, the order it gives for the characters a usage window
/// id can hold is: ECMAScript punctuation before digits before letters, the punctuation
/// among themselves in `CLDR` root order, letters ignoring case, and lowercase before
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
const PRIMARY_ORDER: &str = " _-,;:!?'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

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
