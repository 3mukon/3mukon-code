import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from 'node:process';

// Copy independently signed bundles outside the archive. The builder preserves their signatures.
export default async function stageNativeHelpers({ appOutDir, packager }) {
  const contents = join(appOutDir, packager.appInfo.productFilename + '.app', 'Contents');
  if (env.APP_NATIVE_HELPER_STAGE) {
    const helpers = join(contents, 'Helpers');
    const name = 'Computer Use Helper.app';
    await mkdir(helpers, { recursive: true });
    await cp(join(env.APP_NATIVE_HELPER_STAGE, name), join(helpers, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  if (env.APP_CHROME_CONNECTOR_STAGE) {
    const stage = env.APP_CHROME_CONNECTOR_STAGE;
    const { extensionId } = JSON.parse(await readFile(join(stage, 'candidate.json'), 'utf8'));
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId))
      throw new Error('Invalid Chrome extension identity.');
    const destination = join(contents, 'Resources', 'chrome-connector');
    await mkdir(destination, { recursive: true });
    await cp(join(stage, 'BrowserHost'), join(destination, 'BrowserHost'), {
      force: false,
      errorOnExist: true,
    });
    await cp(join(stage, 'extension'), join(destination, 'extension'), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await writeFile(join(destination, 'connector.json'), JSON.stringify({ extensionId }), {
      flag: 'wx',
    });
  }
}
