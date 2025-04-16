import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// Funções utilitárias do server.js
function sanitizeDoc(str) {
  return str.replace(/\D/g, '');
}

export default async function handler(req, res) {
  // CORS headers para Vercel
  res.setHeader('Access-Control-Allow-Origin', 'https://consulta-in100.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // Conexão com o banco
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  try {
    const { cpf, nb, login } = req.body;
    if (!cpf || !nb || !login) {
      return res.status(400).json({ error: 'CPF, NB e login são obrigatórios.' });
    }
    const rawCPF = sanitizeDoc(cpf);
    const rawNB = sanitizeDoc(nb);

    // Exemplo de consulta ao banco (adapte conforme sua lógica)
    const [rows] = await pool.query(
      'SELECT * FROM consultas_api WHERE numero_documento = ? AND numero_beneficio = ? ORDER BY data_hora_registro DESC LIMIT 1',
      [rawCPF, rawNB]
    );

    if (rows.length > 0) {
      return res.status(200).json({ consultas_api: rows[0] });
    } else {
      return res.status(404).json({ error: 'Consulta não encontrada.' });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno no servidor ao processar a consulta.' });
  } finally {
    await pool.end();
  }
}
