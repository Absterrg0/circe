#!/usr/bin/env node
/**
 * Installs circe-core (`@absterrg0/circe-core`), Circe's private
 * interpretation core, into apps/server when a token can read it. It is not a
 * declared dependency, so public checkouts install and build without it; the
 * server then runs with the Circe host layer off (see
 * apps/server/src/circe/host/core.ts). A server bundle built with it
 * installed includes it.
 *
 * The token is CIRCE_CORE_TOKEN, or else the GitHub CLI's, and needs
 * read:packages on Absterrg0/circe-core. Runs on every `pnpm install`. To take
 * a new version, update VERSION and INTEGRITY.
 */

import * as NodeCrypto from "node:crypto";

import { HostProcessPlatform } from "@circe/shared/hostProcess";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { windowsSystemTar } from "./build-cli-archive.ts";

const NAME = "@absterrg0/circe-core";
const VERSION = "0.1.0";
const INTEGRITY =
  "sha512-7OmfH1MQcEhub+fCt1gp1wjErqTv8fY4OrxuMLEE6x5g6juRreBaec3zB5suymRiCxx6KU/KYaNTWvV+sqZrDQ==";
const REGISTRY = "https://npm.pkg.github.com";

export class CirceCoreIntegrityError extends Schema.TaggedError<CirceCoreIntegrityError>()(
  "CirceCoreIntegrityError",
  { version: Schema.String, integrity: Schema.String },
) {
  override get message(): string {
    return `circe-core ${this.version} does not match its pinned integrity (got ${this.integrity}); not installed.`;
  }
}

export class CirceCoreTarError extends Schema.TaggedError<CirceCoreTarError>()(
  "CirceCoreTarError",
  { exitCode: Schema.Int },
) {
  override get message(): string {
    return `Extracting circe-core failed: tar exited with code ${this.exitCode}.`;
  }
}

const Manifest = Schema.Struct({ version: Schema.String });
const Packument = Schema.Struct({
  versions: Schema.Record(
    Schema.String,
    Schema.Struct({ dist: Schema.Struct({ tarball: Schema.String }) }),
  ),
});

const installedVersion = Effect.fn("installedVersion")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(target, "package.json")).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Manifest))),
    Effect.map((manifest) => Option.some(manifest.version)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
});

/** CIRCE_CORE_TOKEN, or else the GitHub CLI's token. */
const token = Effect.gen(function* () {
  const fromEnv = yield* Config.string("CIRCE_CORE_TOKEN").pipe(Config.option);
  if (Option.isSome(fromEnv) && fromEnv.value.trim().length > 0) return fromEnv.value.trim();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("gh", ["auth", "token"]));
  const [stdout, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
      ),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return Number(exitCode) === 0 ? stdout.trim() : "";
}).pipe(
  Effect.scoped,
  Effect.orElseSucceed(() => ""),
);

const download = Effect.fn("download")(function* (auth: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.bearerToken(auth)),
    HttpClient.filterStatusOk,
  );
  const packument = yield* client
    .get(`${REGISTRY}/${NAME.replace("/", "%2f")}`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Packument)));
  const release = packument.versions[VERSION];
  if (release === undefined) return Option.none<Uint8Array>();
  const response = yield* client.get(release.dist.tarball);
  return Option.some(new Uint8Array(yield* response.arrayBuffer));
});

const extract = Effect.fn("extract")(function* (bytes: Uint8Array, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "circe-core-" });
  const file = path.join(scratch, "package.tgz");
  yield* fs.writeFile(file, bytes);
  yield* fs.remove(target, { recursive: true, force: true });
  yield* fs.makeDirectory(target, { recursive: true });
  const tar = platform === "win32" ? windowsSystemTar() : "tar";
  const child = yield* spawner.spawn(
    ChildProcess.make(tar, ["-xzf", file, "-C", target, "--strip-components=1"]),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) return yield* new CirceCoreTarError({ exitCode });
});

const fetchCirceCore = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const target = path.join(repoRoot, "apps", "server", "node_modules", ...NAME.split("/"));
  if (Option.getOrUndefined(yield* installedVersion(target)) === VERSION) return;
  const skip = (reason: string) =>
    Effect.logInfo(`circe-core not installed (${reason}); the Circe host layer will be off.`);

  const auth = yield* token;
  if (auth.length === 0) return yield* skip("no token");
  const fetched = yield* download(auth).pipe(Effect.result);
  if (fetched._tag === "Failure") return yield* skip(fetched.failure.message);
  if (Option.isNone(fetched.success)) return yield* skip(`version ${VERSION} is not published`);

  const bytes = fetched.success.value;
  const integrity = `sha512-${NodeCrypto.createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== INTEGRITY) {
    return yield* new CirceCoreIntegrityError({ version: VERSION, integrity });
  }
  yield* extract(bytes, target).pipe(Effect.scoped);
  yield* Effect.logInfo(`circe-core ${VERSION} installed.`);
});

if (import.meta.main) {
  fetchCirceCore.pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
