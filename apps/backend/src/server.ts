import app from './app.js';
import { config } from './config.js';
import { seedDatabase } from './seed.js';
import { connectDatabase } from './models.js';

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
    ?? details.find(({ code }) => ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET'].includes(code))
    ?? details.find(({ name }) => name === 'MongoParseError')
    ?? details.find(({ name }) => name !== '');
  const code = selected?.code || 'none';
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

const startServer = async () => {
  try {
    console.info(
      `MongoDB configuration: MONGODB_URI ${config.mongoConfigured ? 'is set' : 'is not set'} `
      + `(source: ${config.mongoUriSource}${config.mongoUriOverridden ? ', process environment overrides apps/backend/.env' : ''}).`,
    );
    if (config.mongoConfigured) {
      const { valid, username, hostname, database } = config.mongoUriMetadata;
      console.info(
        `MongoDB target: valid=${valid}; username=${username || '(missing)'}; `
        + `host=${hostname || '(missing)'}; database=${database || '(default)'}.`,
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
        process.exit(1);
      }
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      console.warn(`MongoDB connection failed (${errorType}); using in-memory demo storage. Changes will not persist across restarts.`);
    }
    await seedDatabase();
    const server = app.listen(config.port, () => {
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
