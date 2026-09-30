// Copia a Supabase (schema legacy_sqlserver) las tablas del SQL Server viejo
// que usa remitos, para que siga funcionando después de apagarlo (pedido
// explícito del usuario, 2026-09-30). Solo lectura sobre el SQL Server.
//
// Uso (desde server/, con SQL_* y SUPABASE_DATABASE_URL en .env):
//   node scripts/copiar_legacy_a_supabase.mjs
//
// Se puede correr las veces que haga falta: reemplaza las tablas enteras en
// UNA transacción (si algo falla, queda la copia anterior intacta). La idea
// es correrlo una última vez cuando el sistema viejo deje de usarse.
//
// Tipos: se respetan los del SQL Server (char(n) sigue siendo char(n), así
// las comparaciones ignoran los espacios de relleno igual que antes) y los
// nombres de columna se guardan "plegados" como los pliega Postgres sin
// comillas (solo A-Z en minúscula), para que las consultas viejas sin
// comillas los encuentren. legacy_sqlserver.columnas guarda el nombre
// original de cada columna para devolver las filas con las mismas claves.
import dotenv from 'dotenv';
import sql from 'mssql';
import pkg from 'pg';

dotenv.config();
const { Client } = pkg;

const SCHEMA = 'legacy_sqlserver';
const TABLAS = {
  Portones: ['NTASVTAS', 'INTASVTAS', 'PRODUCTOS', 'REMITOS', 'IREMITOS', 'VENTAS'],
  Paneles: ['NTASVTAS', 'INTASVTAS', 'PRODUCTOS', 'REMITOS', 'IREMITOS', 'VENTAS'],
  WebApp: ['Pre_Produccion'],
};

export function plegar(nombre) {
  return String(nombre).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function tipoPg(c) {
  const t = c.DATA_TYPE.toLowerCase();
  const len = c.CHARACTER_MAXIMUM_LENGTH;
  switch (t) {
    case 'char': case 'nchar': return `char(${len})`;
    case 'varchar': case 'nvarchar': return len && len > 0 ? `varchar(${len})` : 'text';
    case 'text': case 'ntext': return 'text';
    case 'int': return 'integer';
    case 'smallint': case 'tinyint': return 'smallint';
    case 'bigint': return 'bigint';
    case 'bit': return 'boolean';
    case 'decimal': case 'numeric': return `numeric(${c.NUMERIC_PRECISION},${c.NUMERIC_SCALE})`;
    case 'money': return 'numeric(19,4)';
    case 'smallmoney': return 'numeric(10,4)';
    case 'float': return 'double precision';
    case 'real': return 'real';
    case 'datetime': case 'smalldatetime': case 'datetime2': return 'timestamp';
    case 'date': return 'date';
    case 'uniqueidentifier': return 'text';
    default: throw new Error(`Tipo sin mapear: ${t} (${c.TABLE_NAME}.${c.COLUMN_NAME})`);
  }
}

// mssql (useUTC) devuelve datetime como Date "en UTC": se guarda esa misma
// hora de pared en timestamp sin zona (el lector la vuelve a leer como UTC).
function valorPg(v, tipo) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (tipo === 'date') return v.toISOString().slice(0, 10);
    return v.toISOString().replace('T', ' ').replace('Z', '');
  }
  return v;
}

async function main() {
  const ms = await sql.connect({
    user: process.env.SQL_USER, password: process.env.SQL_PASSWORD, server: process.env.SQL_SERVER,
    port: Number(process.env.SQL_PORT || 1433), database: 'master',
    options: { encrypt: false, trustServerCertificate: true }, requestTimeout: 600000,
  });
  const ssl = (process.env.SUPABASE_SSL ?? 'false').toLowerCase() !== 'false' ? { rejectUnauthorized: false } : false;
  const pg = new Client({ connectionString: process.env.SUPABASE_DATABASE_URL, ssl });
  await pg.connect();

  const resumen = [];
  try {
    await pg.query('begin');
    await pg.query(`create schema if not exists ${SCHEMA}`);
    await pg.query(`create table if not exists ${SCHEMA}.columnas (
      db text not null, tabla text not null, columna_pg text not null, columna_original text not null,
      orden integer not null, primary key (db, tabla, columna_pg))`);
    await pg.query(`create table if not exists ${SCHEMA}.cargas (
      db text not null, tabla text not null, filas integer not null, cargado_at timestamptz not null default now(),
      primary key (db, tabla))`);

    for (const [db, tablas] of Object.entries(TABLAS)) {
      for (const tabla of tablas) {
        const cols = (await ms.request().query(`
          select COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, ORDINAL_POSITION, TABLE_NAME
            from [${db}].INFORMATION_SCHEMA.COLUMNS where TABLE_NAME = '${tabla}' order by ORDINAL_POSITION`)).recordset;
        if (!cols.length) throw new Error(`No existe ${db}.dbo.${tabla}`);

        const destino = `${SCHEMA}.${plegar(db)}_${plegar(tabla)}`;
        const defs = cols.map((c) => ({ original: c.COLUMN_NAME, pg: plegar(c.COLUMN_NAME), tipo: tipoPg(c) }));
        await pg.query(`drop table if exists ${destino}`);
        await pg.query(`create table ${destino} (${defs.map((d) => `"${d.pg}" ${d.tipo}`).join(', ')})`);

        const filas = (await ms.request().query(`select * from [${db}].dbo.[${tabla}]`)).recordset;
        const LOTE = 500;
        for (let i = 0; i < filas.length; i += LOTE) {
          const lote = filas.slice(i, i + LOTE);
          const valores = [];
          const tuplas = lote.map((f) => `(${defs.map((d) => {
            valores.push(valorPg(f[d.original], d.tipo));
            return `$${valores.length}`;
          }).join(',')})`);
          await pg.query(`insert into ${destino} (${defs.map((d) => `"${d.pg}"`).join(',')}) values ${tuplas.join(',')}`, valores);
        }

        await pg.query(`delete from ${SCHEMA}.columnas where db = $1 and tabla = $2`, [plegar(db), plegar(tabla)]);
        for (const [i, d] of defs.entries()) {
          await pg.query(`insert into ${SCHEMA}.columnas (db, tabla, columna_pg, columna_original, orden) values ($1,$2,$3,$4,$5)`,
            [plegar(db), plegar(tabla), d.pg, d.original, i + 1]);
        }
        await pg.query(`insert into ${SCHEMA}.cargas (db, tabla, filas) values ($1,$2,$3)
          on conflict (db, tabla) do update set filas = excluded.filas, cargado_at = now()`, [plegar(db), plegar(tabla), filas.length]);

        const { rows: [{ n }] } = await pg.query(`select count(*)::int n from ${destino}`);
        if (n !== filas.length) throw new Error(`${destino}: se leyeron ${filas.length} filas y quedaron ${n}`);
        resumen.push({ tabla: destino, filas: n });
      }
    }
    await pg.query('commit');
  } catch (err) {
    await pg.query('rollback').catch(() => {});
    throw err;
  } finally {
    await pg.end();
    await ms.close();
  }
  console.table(resumen);
}

main().catch((err) => {
  console.error('Error copiando el SQL Server viejo a Supabase:', err.message);
  process.exit(1);
});
