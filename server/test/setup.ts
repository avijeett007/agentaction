process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./test.db';
