import {miscUtils, tgzUtils}                                   from '@yarnpkg/core';
import {CwdFS, Filename, npath, ppath, xfs, type PortablePath} from '@yarnpkg/fslib';
import chalk                                                   from 'chalk';
import crossSpawn                                              from 'cross-spawn';
import {once}                                                  from 'events';
import type {SpawnOptions}                                     from 'node:child_process';
import {tmpdir}                                                from 'node:os';
import {promisify}                                             from 'node:util';
import {brotliCompress}                                        from 'node:zlib';
import pLimit                                                  from 'p-limit';
import semver                                                  from 'semver';

export const BASE_DIR = process.env.GEN_PATCHES_BASE_DIR
  ? npath.toPortablePath(process.env.GEN_PATCHES_BASE_DIR)
  : ppath.join(npath.toPortablePath(tmpdir()), `yarn-compat-gen-patches`);

function formatArg(arg: string) {
  if (arg.includes(` `)) {
    if (!arg.includes(`'`)) {
      return `'${arg}'`;
    } else if (!arg.includes(`"`) && !arg.includes(`$`) && !arg.includes(`\``) && !arg.includes(`\\`)) {
      return `"${arg}"`;
    } else {
      return `'${arg.replace(/'/g, `'"'"'`)}'`;
    }
  }

  return arg;
}
export function spawn(binary: string, args: Array<string>, opts: SpawnOptions = {}) {
  const child = crossSpawn(binary, args, {
    ...opts,
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      ...opts.env,
    },
  });

  const outChunks: Array<Buffer> = [];
  const allChunks: Array<Buffer> = [];
  child.stdout?.on(`data`, chunk => {
    outChunks.push(chunk);
    allChunks.push(chunk);
  });
  child.stderr?.on(`data`, chunk => {
    allChunks.push(chunk);
  });

  const close = once(child, `close`).catch(err => {
    err.message += `\n\n${Buffer.concat(allChunks).toString()}\n`;
    throw err;
  });
  close.catch(() => {}); // Prevent unhandled rejection - the caller should handle i

  return {
    process: child,
    cmd: `${binary} ${args.map(formatArg).join(` `)}`,

    close,
    get exit() {
      return close.then(([code]) => code);
    },
    get success() {
      return close.then(([code]) => {
        if (code !== 0) {
          throw new Error([
            `Process failed`,
            ` Command: ${binary} ${args.join(` `)}`,
            ` Exit code: ${code}`,
            ` Output:\n${Buffer.concat(allChunks).toString()}`,
          ].join(`\n`));
        }
      });
    },

    get output() {
      return close.then(() => Buffer.concat(outChunks));
    },
  };
}

export const logger = {
  indent: 0,
  log(message: string) {
    console.log(`${` `.repeat(this.indent)}${chalk.grey(message)}`);
  },
  info(message: string) {
    console.log(`${` `.repeat(this.indent)}${message}`);
  },
  warn(message: string) {
    console.log(`${` `.repeat(this.indent)}${chalk.yellow(message)}`);
  },
  async section<T>(title: string, cb: () => Promise<T>): Promise<T> {
    this.info(`- ${title}`);
    this.indent += 2;
    try {
      return await cb();
    } finally {
      this.indent -= 2;
    }
  },
};

export async function diff(range: string, dir: PortablePath, opts: Array<string>): Promise<string> {
  const patch = await spawn(`git`, [
    `diff`,
    `--no-index`,
    `--diff-algorithm=default`,
    `--src-prefix=a/`,
    `--dst-prefix=b/`,
    ...opts,
    `base`,
    `patched`,
  ], {
    cwd: npath.fromPortablePath(dir),
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: `1`,
      HOME: ``,
      XDG_CONFIG_HOME: ``,
      USERPROFILE: ``,
    },
  }).output;

  return patch.toString()
    .replace(/^diff --git (?<src>.+) (?<dst>.+)\n(?<fields>(?:\w.+\n)+)--- (\1|\/dev\/null)\n\+\+\+ \2\n/gm, (_, src, dst, fields, src2) => {
      // It is possible to get "a/patched", specifically when the diff is creating a file
      const base = src.replace(/^("?a\/)(base|patched)\//, `$1`);
      const patched = dst.replace(/^("?b\/)patched\//, `$1`);
      return [
        `diff --git ${base} ${patched}`,
        fields.slice(0, -1),
        `semver exclusivity ${range}`,
        `--- ${src2 === `/dev/null` ? `/dev/null` : base}`,
        `+++ ${patched}`,
        ``,
      ].join(`\n`);
    });
}

export abstract class PatchGenerator<S extends {id: string, range: string}> {
  protected readonly tmp: PortablePath;
  protected readonly patches: PortablePath;

  // Only used to minimize patch changes when migrating to new system
  protected diffOpts: Array<string> = [];

  public constructor(
    public readonly name: string,
    protected readonly slices: Array<S>,
  ) {
    this.tmp = ppath.join(BASE_DIR, this.name as Filename);
    this.patches = ppath.join(npath.toPortablePath(__dirname), this.name as Filename, `patches`);
  }

  protected abstract build(slice: S, path: PortablePath): Promise<void>;
  protected abstract getValidateVersions(slice: S): Promise<Array<string>>;

  private async fetchTarball(version: string): Promise<Buffer> {
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(`https://registry.yarnpkg.com/${this.name}/-/${this.name}-${version}.tgz`);
    if (!response.ok)
      throw new Error(`Failed to fetch tarball for ${this.name}@${version} - ${response.status} ${response.statusText}`);
    if (!response.body)
      throw new Error(`Failed to fetch tarball for ${this.name}@${version} - Empty body`);

    return Buffer.from(await response.arrayBuffer());
  }
  protected async getTarball(version: string): Promise<Buffer> {
    const path = ppath.join(this.tmp, `tarballs`, `${version}.tgz` as Filename);
    if (await xfs.existsPromise(path))
      return xfs.readFilePromise(path);

    const [tarball] = await Promise.all([
      this.fetchTarball(version),
      xfs.mkdirpPromise(ppath.dirname(path)),
    ]);

    await xfs.writeFilePromise(path, tarball);
    return tarball;
  }

  protected createPatch(slice: S): Promise<string> {
    return logger.section(`Create patch`, async () => {
      const patchPath = ppath.join(this.patches, `patch-${slice.id}.diff` as Filename);

      if (await xfs.existsPromise(patchPath)) {
        const originalContent = await xfs.readFilePromise(patchPath, `utf8`);
        const updatedContent = originalContent.replace(/^semver exclusivity .*\n/gm, `semver exclusivity ${slice.range}\n`);
        if (originalContent !== updatedContent) {
          await xfs.writeFilePromise(patchPath, updatedContent);
          logger.log(`> Reusing cached patch ${ppath.basename(patchPath)} (range updated)`);
        } else {
          logger.log(`> Reusing cached patch ${ppath.basename(patchPath)}`);
        }

        return updatedContent;
      } else {
        const buildPath = ppath.join(this.tmp, `builds`, slice.id as Filename);
        const base = ppath.join(buildPath, `base`);
        const patched = ppath.join(buildPath, `patched`);

        if (await xfs.existsPromise(buildPath)) {
          await logger.section(`Build`, async () => logger.log(chalk.grey(`> Reusing cached builds`)));
        } else {
          await xfs.mkdirpPromise(buildPath);
          await this.build(slice, buildPath);
        }

        return await logger.section(`Generate diff`, () => {
          logger.log(`--- ${npath.fromPortablePath(base)}`);
          logger.log(`+++ ${npath.fromPortablePath(patched)}`);
          return diff(slice.range, buildPath, this.diffOpts);
        });
      }
    });
  }

  protected readonly envs = new Map<string, Promise<PortablePath>>();
  protected async getValidationEnv(version: string): Promise<PortablePath> {
    return miscUtils.getFactoryWithDefault(this.envs, version, () =>  this.prepareValidationEnv(version));
  }
  protected async prepareValidationEnv(version: string): Promise<PortablePath> {
    const path = ppath.join(this.tmp, `validate`, version as Filename);
    const [tarball] = await Promise.all([
      this.getTarball(version),
      xfs.mkdirpPromise(path),
    ]);
    await tgzUtils.extractArchiveTo(tarball, new CwdFS(path), {stripComponents: 1});
    return path;
  }
  private prepareAllValidationEnvs(slices: Array<S>, {signal}: {signal?: AbortSignal} = {}): void {
    const limit = pLimit(5);
    for (const slice of slices) {
      this.getValidateVersions(slice)
        .then(versions => {
          for (const version of versions) {
            limit(async () => {
              if (signal?.aborted)
                return null;

              return this.getValidationEnv(version);
            });
          }
        })
        .catch(() => {}); // Prevent unhandled rejection - errors will be handled during validation
    }
  }
  protected validatePatch(slice: S, patch: string): Promise<void> {
    return logger.section(`Validate patch`, async () => {
      for (const version of await this.getValidateVersions(slice)) {
        await logger.section(version, async () => {
          const env = await this.getValidationEnv(version);

          const child = spawn(`git`, [`apply`, `--check`, `-`], {
            cwd: npath.fromPortablePath(env),
          });
          child.process.stdin!.write(patch.replace(/^semver exclusivity .*\n/gm, ``));
          child.process.stdin!.end();
          await child.success;
        });
      }
    });
  }

  protected async generatePatch(slice: S): Promise<string> {
    const clearBuildCache = () => xfs.removeSync(ppath.join(this.tmp, `builds`, slice.id as Filename));

    return await logger.section(`Generate patch ${slice.id} (${slice.range})`, async () => {
      const $ensure = xfs.mkdirpPromise(this.patches);
      $ensure.catch(() => {});

      // If process exits while creating a patch, or the created patch fails validation,
      // remove the build cache so as to not corrupt future builds
      process.once(`exit`, clearBuildCache);
      const content = await this.createPatch(slice);
      await this.validatePatch(slice, content);
      process.off(`exit`, clearBuildCache);

      // Save the patch file only after validation
      await $ensure;
      await xfs.writeFilePromise(ppath.join(this.patches, `patch-${slice.id}.diff` as Filename), content);

      return content;
    });
  }

  public async generateBundle(ranges: Array<string>, path: PortablePath): Promise<void> {
    // Start preparing validation environments immediately
    const controller = new AbortController();
    const signal = controller.signal;
    this.prepareAllValidationEnvs(this.slices, {signal});

    const regenerate = ranges.join(` || `);

    try {
      const patches: Array<string> = [];
      for (const slice of this.slices) {
        if (ranges.length > 0 && semver.intersects(regenerate, slice.range, {includePrerelease: true})) {
          // Force fresh build by clearing cached files
          await Promise.all([
            xfs.removePromise(ppath.join(this.patches, `patch-${slice.id}.diff` as Filename)),
            xfs.removePromise(ppath.join(this.tmp, `builds`, slice.id as Filename)),
          ]);
        }

        patches.push(await this.generatePatch(slice));
      }

      await logger.section(`Generate final patch bundle`, async () => {
        const aggregate = await promisify(brotliCompress)(patches.join(``));

        const bundle = Buffer.from([
          `let patch: string;`,
          ``,
          `export function getPatch() {`,
          `  if (typeof patch === \`undefined\`)`,
          `    patch = require(\`zlib\`).brotliDecompressSync(Buffer.from(\`${aggregate.toString(`base64`)}\`, \`base64\`)).toString();`,
          ``,
          `  return patch;`,
          `}`,
          ``,
        ].join(`\n`));

        await xfs.writeFilePromise(path, bundle);
      });

      await logger.section(`Prune caches`, async () => {
        const buildNames = new Set(this.slices.map(slice => slice.id as Filename));
        const patchNames = new Set(this.slices.map(slice => `patch-${slice.id}.diff` as Filename));

        await Promise.all([
          xfs.removePromise(ppath.join(this.tmp, `validate`)),
          xfs.readdirPromise(this.patches).then(names => Promise.all(
            names.filter(name => !patchNames.has(name)).map(name => xfs.removePromise(ppath.join(this.patches, name))),
          )),
          xfs.readdirPromise(ppath.join(this.tmp, `builds`)).then(names => Promise.all(
            names.filter(name => !buildNames.has(name)).map(name => xfs.removePromise(ppath.join(this.tmp, `builds`, name))),
          )),
        ]);
      });
    } catch (err) {
      controller.abort();
      await xfs.removePromise(ppath.join(this.tmp, `validate`));
      throw err;
    }
  }
}
