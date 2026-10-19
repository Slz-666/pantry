/**
 * MySQL 连接池 + 事务封装。
 *
 * 为什么 dateStrings: true —— DATE 列如果被驱动转成 JS Date，序列化出去会变成
 * "2026-08-23T16:00:00.000Z" 这种差一天的字符串；返回原始 "2026-08-24" 才对。
 * 为什么 timezone: '+08:00' —— 日期解析/生成都在北京时间，避免服务器时区漂移。
 * 为什么 decimalNumbers: false —— DECIMAL（0.5 斤这类数量）以字符串返回，
 *   业务层需要时显式转换；绝不让浮点误差悄悄传播。
 * namedPlaceholders: true —— 后续 SQL 用 :name 传参，字段多时更可读。
 */
import './env.js';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pantry',
  charset: 'utf8mb4',
  dateStrings: true,
  timezone: '+08:00',
  namedPlaceholders: true,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: false,
});

/** 普通查询：返回 rows。写操作返回 ResultSetHeader。 */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * 事务封装：所有「改库存数量」的路径必须走这里。
 * FOR UPDATE 的锁只在事务内有效；getConnection → beginTransaction → 业务
 * → commit，出错 rollback，最后必须 release，否则连接池里会挂死未结束的事务。
 * 业务回调拿到的 conn 上也要用 conn.execute / conn.query。
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // 连接已坏时 rollback 也会抛错，吞掉以保留原始错误
    }
    throw err;
  } finally {
    conn.release();
  }
}

export { pool };
