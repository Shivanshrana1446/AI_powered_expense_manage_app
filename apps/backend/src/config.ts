import dotenv from 'dotenv';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = basename(dirname(configDirectory)) === 'dist'
  ? resolve(configDirectory, '..', '..')
  : resolve(configDirectory, '..');
const backendEnvPath = resolve(backendDirectory, '.env');
const processMongoUri = process.env.MONGODB_URI;
const dotenvResult = dotenv.config({ path: backendEnvPath });
const mongoUriFromFile = dotenvResult.parsed?.MONGODB_URI?.trim() || '';
const processMongoUriValue = (processMongoUri || '').trim();
const mongoUriValue = (process.env.MONGODB_URI || '').trim();
const legacyMongoUri = (process.env.MONGO_URI || dotenvResult.parsed?.MONGO_URI || '').trim();

if (!processMongoUriValue && mongoUriFromFile && processMongoUri !== undefined) {
  throw new Error('MONGODB_URI is empty in the backend process environment and is masking the configured value in apps/backend/.env.');
}

if (!mongoUriValue && legacyMongoUri) {
  throw new Error('MONGO_URI is not supported; configure MONGODB_URI in apps/backend/.env or the backend process environment.');
}

const mongoUriSource = processMongoUri !== undefined
  ? 'process environment'
  : mongoUriFromFile
    ? 'apps/backend/.env'
    : 'default';
const mongoUriOverridden = Boolean(
  processMongoUri !== undefined
  && mongoUriFromFile
  && processMongoUriValue !== mongoUriFromFile,
);

const getMongoUriMetadata = (uri: string) => {
  if (!uri) return { valid: false, username: '', hostname: '', database: '' };

  try {
    const parsed = new URL(uri);
    const username = decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
    return {
      valid: ['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)
        && Boolean(parsed.hostname),
      username,
      hostname: parsed.hostname,
      database: decodeURIComponent(parsed.pathname.slice(1).split('/')[0].split('?')[0]),
    };
  } catch {
    return { valid: false, username: '', hostname: '', database: '' };
  }
};

export const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: mongoUriValue || 'mongodb://127.0.0.1:27017/expense-policy-review',
  mongoConfigured: Boolean(mongoUriValue),
  mongoUriSource,
  mongoUriOverridden,
  mongoUriMetadata: getMongoUriMetadata(mongoUriValue),
  geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
  demoMode: process.env.DEMO_MODE === 'true'
    || (process.env.DEMO_MODE !== 'false' && !(process.env.GEMINI_API_KEY || '').trim()),
  jwtSecret: (process.env.JWT_SECRET || 'demo-secret').trim(),
};
