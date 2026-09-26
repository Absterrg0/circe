import type * as Cause from "effect/Cause";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import {
  CirceQuickLookupInput,
  type CirceLookupDay,
  type CirceQuickLookupResult,
} from "@circe/contracts";
import { extractLocationCandidates } from "@circe/core/place";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

const decodeLookupInput = Schema.decodeEffect(CirceQuickLookupInput);
const Place = Schema.Struct({
  name: Schema.String,
  latitude: Schema.Finite,
  longitude: Schema.Finite,
  timezone: Schema.String,
  country: Schema.optionalKey(Schema.String),
  country_code: Schema.optionalKey(Schema.String),
  admin1: Schema.optionalKey(Schema.String),
});
const Places = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(Place).check(Schema.isMaxLength(10))),
});
const Forecast = Schema.Struct({
  current: Schema.Struct({
    time: Schema.String,
    temperature_2m: Schema.Finite,
    apparent_temperature: Schema.Finite,
    weather_code: Schema.Int,
  }),
  daily: Schema.Struct({
    time: Schema.Array(Schema.String),
    temperature_2m_max: Schema.Array(Schema.Finite),
    temperature_2m_min: Schema.Array(Schema.Finite),
    precipitation_probability_max: Schema.Array(Schema.Finite),
  }),
});
const placeLabel = (place: typeof Place.Type) =>
  [...new Set([place.name, place.admin1, place.country].filter(Boolean))].join(", ");
const normalized = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Fold to a space-separated token stream so punctuation cannot hide a boundary. */
const placeTokens = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/**
 * The location must appear in the utterance as a whole token phrase. Plain
 * substring matching let the model invent a fragment of a real place
 * ("castle" from Newcastle, "ham" from Birmingham); a boundary check refuses
 * the fragment while still accepting the named place.
 */
const placeMentioned = (source: string, location: string): boolean => {
  const needle = placeTokens(location);
  if (needle.length === 0) return false;
  const pattern = needle.split(" ").map(escapeRegExp).join("\\s+");
  return new RegExp(`(?:^|\\s)${pattern}(?:\\s|$)`, "u").test(placeTokens(source));
};
const condition = (code: number) => {
  if (code === 0) return "clear skies";
  if (code <= 3) return "partly cloudy to overcast skies";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95 && code <= 99) return "thunderstorms";
  return "conditions unavailable";
};

/**
 * Structured lookup outcome. A missing or ambiguous place is a question the
 * interaction owns, not a failed request: the slot, prompt, known arguments,
 * and offered choices travel together so any device can answer it.
 */
export type CirceLookupOutcome =
  | {
      readonly status: "answer";
      readonly message: string;
      readonly source: string;
      readonly location: string;
      readonly day: CirceLookupDay;
    }
  | {
      readonly status: "question";
      readonly slot: "location" | "day";
      readonly reason:
        | "place-not-mentioned"
        | "ambiguous-place"
        | "place-not-found"
        | "day-unavailable";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
      readonly known: Readonly<Record<string, string>>;
    }
  | { readonly status: "unavailable"; readonly message: string };

export type CirceLookupInput = {
  readonly kind: "weather" | "time";
  readonly location: string;
  readonly day: CirceLookupDay;
  readonly sourceUtterance: string;
};

/**
 * Fixed-origin, read-only tools. No model, provider session, filesystem, or
 * task dispatch. The place must appear in the user's own utterance; the
 * runner returns a typed question instead of guessing.
 */
export const runCirceLookup = (
  rawInput: CirceLookupInput,
  preset: "full" | "controller" | "headless",
): Effect.Effect<CirceLookupOutcome, never, HttpClient.HttpClient> =>
  Effect.gen(function* (): Effect.fn.Return<
    CirceLookupOutcome,
    Schema.SchemaError | HttpClientError.HttpClientError | Cause.UnknownError,
    HttpClient.HttpClient
  > {
    if (preset === "headless")
      return {
        status: "unavailable",
        message: "Quick assistant lookups need a Full or Controller node.",
      };
    const input = yield* decodeLookupInput(rawInput);
    // The user's own words are the only place source. The supplied location
    // must appear in the utterance; the utterance's other bounded spans are
    // tried after it, so a spoken answer like "it's in London" resolves to
    // London instead of failing as a whole phrase.
    if (!placeMentioned(input.sourceUtterance, input.location)) {
      return {
        status: "question",
        slot: "location",
        reason: "place-not-mentioned",
        prompt: "I couldn't match that place to what you said. Which city or place?",
        choices: [],
        known: { tool: input.kind, day: input.day },
      };
    }
    const placeCandidates = [
      ...new Set([input.location, ...extractLocationCandidates(input.sourceUtterance)]),
    ];
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    // A comma-qualified location ("Halol, Gujarat, India") splits directly.
    // A spoken one usually has no commas ("Halol Gujarat India"), so the
    // longest prefix is tried as the place name first and the trailing words
    // become the region qualifiers once the full name fails to geocode.
    const splitsFor = (
      location: string,
    ): ReadonlyArray<{
      readonly name: string;
      readonly regions: ReadonlyArray<string>;
    }> => {
      const parts = location
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (parts.length > 1) {
        return [{ name: parts[0]!, regions: parts.slice(1) }];
      }
      const words = (parts[0] ?? "").split(/\s+/u).filter((word) => word.length > 0);
      const splits: Array<{ readonly name: string; readonly regions: ReadonlyArray<string> }> = [];
      for (let count = words.length; count >= 1; count -= 1) {
        splits.push({
          name: words.slice(0, count).join(" "),
          regions: count < words.length ? words.slice(count) : [],
        });
      }
      return splits;
    };
    // Bound the total geocoding attempts so a long answer with many spans
    // cannot fan out into an unbounded number of outbound requests.
    const MAX_GEOCODE_ATTEMPTS = 12;
    let attempts = 0;
    let selected: typeof Place.Type | undefined;
    let ambiguousName: string | undefined;
    let ambiguousChoices: ReadonlyArray<string> = [];
    for (const place of placeCandidates) {
      if (selected !== undefined || ambiguousName !== undefined) break;
      for (const split of splitsFor(place)) {
        if (attempts >= MAX_GEOCODE_ATTEMPTS) break;
        attempts += 1;
        const geocoding = new URL("https://geocoding-api.open-meteo.com/v1/search");
        geocoding.search = new URLSearchParams({
          name: split.name,
          count: "10",
          language: "en",
          format: "json",
        }).toString();
        const placesResponse = yield* client.get(geocoding.href);
        const places = yield* HttpClientResponse.schemaBodyJson(Places)(placesResponse);
        const matches = (places.results ?? []).filter((place) =>
          split.regions.every((region) =>
            [place.admin1, place.country, place.country_code].some(
              (value) => value !== undefined && normalized(value) === normalized(region),
            ),
          ),
        );
        if (matches.length === 0) continue;
        if (split.regions.length === 0 || matches.length === 1) {
          selected = matches[0];
          break;
        }
        ambiguousName = split.name;
        ambiguousChoices = [...new Set(matches.map(placeLabel))].slice(0, 8);
        break;
      }
    }
    if (selected === undefined) {
      if (ambiguousName !== undefined) {
        return {
          status: "question",
          slot: "location",
          reason: "ambiguous-place",
          prompt: `I found multiple places named ${ambiguousName}. Which one did you mean?`,
          choices: ambiguousChoices,
          known: { tool: input.kind, day: input.day, place: ambiguousName },
        };
      }
      return {
        status: "question",
        slot: "location",
        reason: "place-not-found",
        prompt: `I couldn't find ${input.location}. Say the city, state, and country.`,
        choices: [],
        known: { tool: input.kind, day: input.day },
      };
    }
    const label = placeLabel(selected);
    if (input.kind === "time") {
      // This tool reports the current local time only. "Today" asks for the
      // same clock; a future day cannot be answered, so ask which clock the
      // user wants instead of returning the wrong one.
      if (input.day !== "now" && input.day !== "today") {
        return {
          status: "question",
          slot: "day",
          reason: "day-unavailable",
          prompt: "I can only tell you the current local time. Say now or today.",
          choices: ["now", "today"],
          known: { tool: input.kind, location: label },
        };
      }
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const time = yield* Effect.try(() =>
        new Intl.DateTimeFormat("en", {
          timeZone: selected.timezone,
          weekday: "long",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(now),
      );
      return {
        status: "answer",
        message: `${label}: ${time}.`,
        source: "https://open-meteo.com/en/docs/geocoding-api",
        location: label,
        day: input.day,
      };
    }
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(selected.latitude),
      longitude: String(selected.longitude),
      timezone: selected.timezone,
      current: "temperature_2m,apparent_temperature,weather_code",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: "2",
    }).toString();
    const response = yield* client.get(url.href);
    const forecast = yield* HttpClientResponse.schemaBodyJson(Forecast)(response);
    if (input.day === "now")
      return {
        status: "answer",
        source: "https://open-meteo.com/",
        message: `${label}: ${forecast.current.temperature_2m}°C, ${condition(forecast.current.weather_code)}, feels like ${forecast.current.apparent_temperature}°C. Updated ${forecast.current.time.replace("T", " ")} local time.`,
        location: label,
        day: input.day,
      };
    const index = input.day === "tomorrow" ? 1 : 0;
    const day = forecast.daily.time[index];
    const low = forecast.daily.temperature_2m_min[index];
    const high = forecast.daily.temperature_2m_max[index];
    const rain = forecast.daily.precipitation_probability_max[index];
    if (day === undefined || low === undefined || high === undefined || rain === undefined)
      return {
        status: "unavailable",
        message: "The weather service returned an incomplete forecast. Try again.",
      };
    return {
      status: "answer",
      source: "https://open-meteo.com/",
      message: `${label}, ${input.day} (${day}): ${low} to ${high}°C, with a ${rain}% chance of rain.`,
      location: label,
      day: input.day,
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed((): CirceLookupOutcome => ({
      status: "unavailable",
      message: "I couldn't reach the weather and place service. Try the lookup again.",
    })),
  );

/** The legacy bounded RPC result. Kept until every client reads interaction state. */
export const runCirceQuickLookup = (
  rawInput: CirceLookupInput,
  preset: "full" | "controller" | "headless",
): Effect.Effect<CirceQuickLookupResult, never, HttpClient.HttpClient> =>
  runCirceLookup(rawInput, preset).pipe(
    Effect.map((outcome): CirceQuickLookupResult => {
      switch (outcome.status) {
        case "answer":
          return { status: "answer", message: outcome.message, source: outcome.source };
        case "question":
          return outcome.reason === "place-not-mentioned" || outcome.reason === "day-unavailable"
            ? { status: "unavailable", message: outcome.prompt }
            : { status: "needs-input", message: outcome.prompt };
        case "unavailable":
          return { status: "unavailable", message: outcome.message };
      }
    }),
  );
