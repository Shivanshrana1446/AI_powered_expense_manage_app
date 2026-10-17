import app from './app.js';
import { config } from './config.js';
import { seedDatabase } from './seed.js';
import { connectDatabase } from './models.js';
import { lookup, resolveSrv, resolveTxt } from 'node:dns/promises';

const readErrorProperty = (value: unknown, key: string): unknown => (
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
);

const getMongoFailureDetails = (error: unknown) => {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const details: Array<{ name: string; code: string; message: string }> = [];

  while (pending.length > 0 && details.length < 20) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);

    const name = readErrorProperty(current, 'name');
    const code = readErrorProperty(current, 'code');
    const message = readErrorProperty(current, 'message');
    details.push({
      name: typeof name === 'string' ? name : '',
      code: typeof code === 'string' || typeof code === 'number' ? String(code) : '',
      message: typeof message === 'string' ? message.toLowerCase() : '',
    });

    for (const key of ['cause', 'error']) {
      const nested = readErrorProperty(current, key);
      if (nested) pending.push(nested);
    }

    const reason = readErrorProperty(current, 'reason');
    if (reason) pending.push(reason);
    const servers = readErrorProperty(reason, 'servers');
    if (servers instanceof Map) {
      for (const server of servers.values()) {
        const serverError = readErrorProperty(server, 'error');
        if (serverError) pending.push(serverError);
      }
    }
  }

  const selected = details.find(({ code }) => code === '8000')
    ?? details.find(({ code }) => code === '13')
    ?? details.find(({ code }) => code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_'))
    ?? details.find(({ message }) => /ERR_(?:SSL|TLS)_[A-Z0-9_]+/i.test(message))
    ?? details.find(({ code }) => ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET'].includes(code))
    ?? details.find(({ name }) => name === 'MongoParseError')
    ?? details.find(({ name }) => name !== '');
  const messageTlsCode = details
    .map(({ message }) => message.match(/ERR_(?:SSL|TLS)_[A-Z0-9_]+/i)?.[0])
    .find((value) => value !== undefined);
  const code = selected?.code || messageTlsCode?.toUpperCase() || 'none';
  const material = details.map(({ message }) => message).join(' ');
  const category = code === '8000' || material.includes('authentication failed')
    ? 'authentication-rejected'
    : code === '13' || material.includes('not authorized')
      ? 'authorization-denied'
      : code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')
        ? 'tls-handshake-failed'
        : ['ENOTFOUND', 'EAI_AGAIN'].includes(code)
          ? 'dns-failed'
          : ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET'].includes(code)
            ? 'network-failed'
            : details.some(({ name }) => name === 'MongoParseError')
              ? 'invalid-uri'
              : 'connection-failed';

  return {
    type: details.find(({ name }) => name !== '')?.name || 'UnknownError',
    code,
    category,
  };
};

const getDnsFailureCode = (error: unknown) => {
  const code = readErrorProperty(error, 'code');
  return typeof code === 'string' && /^[A-Z0-9_-]+$/i.test(code) ? code : 'unknown';
};

const runDnsCheck = async (operation: () => Promise<unknown[]>) => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('DNS diagnostic timed out') as NodeJS.ErrnoException;
          error.code = 'DNS_DIAGNOSTIC_TIMEOUT';
          reject(error);
        }, 3000);
      }),
    ]);
    return { ok: true as const, records };
  } catch (error) {
    return { ok: false as const, error };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const logDnsCheck = async (label: string, operation: () => Promise<unknown[]>) => {
  const result = await runDnsCheck(operation);
  if (result.ok) {
    console.info(`MongoDB DNS ${label}: resolved (${result.records.length} record(s)).`);
    return;
  }

  const code = getDnsFailureCode(result.error);
  if (label === 'TXT lookup' && code === 'ENODATA') {
    console.info('MongoDB DNS TXT lookup: no optional TXT records.');
    return;
  }
  console.warn(`MongoDB DNS ${label}: failed (code=${code}).`);
};

const diagnoseMongoDns = async () => {
  const { protocol, hostname } = config.mongoUriMetadata;
  if (!hostname) {
    console.warn('MongoDB DNS diagnostics skipped: URI does not contain a valid hostname.');
    return;
  }

  if (protocol === 'mongodb+srv:') {
    await Promise.all([
      logDnsCheck('SRV lookup', () => resolveSrv(`_mongodb._tcp.${hostname}`)),
      logDnsCheck('TXT lookup', () => resolveTxt(hostname)),
    ]);
    return;
  }

  await logDnsCheck('address lookup', async () => lookup(hostname, { all: true }));
};

const startServer = async () => {
  try {
    console.info(
      `MongoDB configuration: MONGO_URI ${config.mongoConfigured ? 'is set' : 'is not set'} `
      + `(source: ${config.mongoUriSource}${config.mongoUriOverridden ? ', process environment overrides apps/backend/.env' : ''}).`,
    );
    if (config.mongoConfigured) {
      const { valid, protocol, hostname } = config.mongoUriMetadata;
      console.info(
        `MongoDB target: valid=${valid}; scheme=${protocol || '(unknown)'}; `
        + `host=${hostname || '(missing)'}.`,
      );
    }

    try {
      await connectDatabase();
    } catch (error) {
      if (config.mongoConfigured) {
        const { type, code, category } = getMongoFailureDetails(error);
        if (category === 'authentication-rejected') {
          console.error(`MongoDB connection failed (category=${category}, type=${type}, code=${code}). Atlas rejected authentication. Verify the URI username and database user's password locally; credentials are not logged. Refusing to start with temporary memory storage.`);
        } else if (category === 'authorization-denied') {
          console.error(`MongoDB connection failed (category=${category}, type=${type}, code=${code}). The database user lacks permission for the requested operation. Verify its role in Atlas. Refusing to start with temporary memory storage.`);
        } else {
          console.error(`MongoDB connection failed (category=${category}, type=${type}, code=${code}). Check the URI format, Atlas cluster state, network access, and TLS connectivity. Refusing to start with temporary memory storage.`);
        }
        await diagnoseMongoDns();
        process.exit(1);
      }
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      console.warn(`MongoDB connection failed (${errorType}); using in-memory demo storage. Changes will not persist across restarts.`);
    }
    await seedDatabase();
    const server = app.listen(config.port, '0.0.0.0', () => {
      console.log(`Expense claim policy review assistant running on port ${config.port}`);
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${config.port} is already in use. Stop the other backend instance or set a different PORT in apps/backend/.env.`);
      } else {
        console.error(`Backend listener failed (${error.name || 'UnknownError'}, code=${error.code || 'none'}).`);
      }
      process.exit(1);
    });
  } catch (error) {
    const { type, code, category } = getMongoFailureDetails(error);
    console.error(`Failed to start server (category=${category}, type=${type}, code=${code}).`);
    process.exit(1);
  }
};

startServer();
