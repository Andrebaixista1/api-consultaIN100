import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import mysql from 'mysql2/promise';

const apiCache = {};

function verificarCache(cpf, nb) {
    const key = `${cpf}-${nb}`;
    const cached = apiCache[key];
    if (cached && cached.expiraEm > Date.now()) return cached.valor;
    return null;
}
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static('public'));

// Configuração do CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

function convertDate(str) {
  if (typeof str !== 'string' || str.trim() === '') return null;
  const clean = str.trim();
  if (/^\d{8}$/.test(clean)) {
    const dd = clean.substring(0, 2);
    const mm = clean.substring(2, 4);
    const yyyy = clean.substring(4, 8);
    return `${yyyy}-${mm}-${dd}`;
  }
  return str;
}
function sanitizeDoc(str) {
  return str.replace(/\D/g, '');
}

async function consultarApiComRetentativa(rawCPF, rawNB) {
  const apiUrl = 'https://api.ajin.io/v3/query-inss-balances/finder/await';
  const apiKey = process.env.TOKEN_QUALIBANKING || '';

  let attempts = 0;
  while (attempts < 3) {
      attempts++;
      try {
          if (!apiKey) throw new Error('API key não configurada.');
          const apiResponse = await axios.post(
              apiUrl,
              {
                  identity: rawCPF,
                  benefitNumber: rawNB,
                  lastDays: 0,
                  attemps: 120
              },
              {
                  headers: {
                      apiKey: apiKey,
                      'Content-Type': 'application/json'
                  }
              }
          );

          if (apiResponse.status === 200) {
              const key = `${rawCPF}-${rawNB}`;
              apiCache[key] = {
                  valor: apiResponse.data,
                  expiraEm: Date.now() + 5 * 60 * 1000
              };
              return { status: 200, data: apiResponse.data };
          } else {
              throw new Error(`Erro ao consultar API externa: Status ${apiResponse.status}`);
          }
      } catch (error) {
          console.error(`Tentativa ${attempts} falhou:`, error);
          if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempts - 1)));
      }
  }
  return { status: 500, error: 'Falha ao consultar API após várias tentativas.' };
}

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

async function calculateUserCredits(userId) {
  const [creditRows] = await pool.query(
    'SELECT SUM(total_carregado) AS total_carregado, SUM(limite_disponivel) AS limite_disponivel, SUM(consultas_realizada) AS consultas_realizada FROM creditos WHERE id_user = ?',
    [userId]
  );

  if (creditRows.length > 0 && creditRows[0].total_carregado !== null) {
    return {
      total_carregado: parseInt(creditRows[0].total_carregado),
      limite_disponivel: parseInt(creditRows[0].limite_disponivel),
      consultas_realizada: parseInt(creditRows[0].consultas_realizada)
    };
  } else {
    // If no rows found or total_carregado is null, initialize with 0 values
    return { total_carregado: 0, limite_disponivel: 0, consultas_realizada: 0 };
  }
}

// Rota de LOGIN
app.post('/api/login', async (req, res) => {
  const { login, senha } = req.body;
    try {
        const [userRows] = await pool.query(
            'SELECT id, nome, login, senha, data_criacao, ultimo_log FROM usuarios WHERE login = ? LIMIT 1',
            [login]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        const user = userRows[0];
        if (senha !== user.senha) {
            return res.status(401).json({ error: 'Senha incorreta' });
        }

        await pool.query('UPDATE usuarios SET ultimo_log = NOW() WHERE id = ?', [user.id]);
        const creditos = await calculateUserCredits(user.id);
        delete user.senha;
        user.creditos = creditos;
        return res.json(user);
    } catch (error) {
        console.error('Erro ao realizar login:', error);
        return res.status(500).json({ error: 'Erro ao processar login' });
    }
});

// Rota de CADASTRO
app.post('/api/cadastro', (req, res) => {
  const { nome, login, senha } = req.body;

  // Logando os dados recebidos como um objeto JSON no console
  console.log('Dados recebidos para cadastro:', JSON.stringify({ nome, login, senha }, null, 2));

  // Responder ao front-end que os dados foram recebidos
  // (Você pode adicionar a lógica de salvar no banco de dados aqui depois)
  res.status(200).json({ message: 'Dados de cadastro recebidos com sucesso!' });
});


// Rota de CONSULTA
app.post('/api/consulta', async (req, res) => {
  const { cpf, nb, login } = req.body;
  try {
    if (!cpf || !nb || !login) {
      return res.status(400).json({ error: 'CPF, NB e login são obrigatórios.' });
    }
    const rawCPF = sanitizeDoc(cpf);
    const rawNB = sanitizeDoc(nb);
    
    // Obter o id do usuário
    const [userRows] = await pool.query('SELECT id FROM usuarios WHERE login = ? LIMIT 1', [login]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado para registrar a consulta.' });
    }
    const userId = userRows[0].id;
    
    // Verificar créditos
    const [creditRows] = await pool.query(
      'SELECT limite_disponivel, consultas_realizada FROM creditos WHERE id_user = ? LIMIT 1',
      [userId]
    );
    if (creditRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma operação de crédito encontrada para este usuário.' });
    }
    let limiteDisp = parseInt(creditRows[0].limite_disponivel) || 0;
    let consultasReal = parseInt(creditRows[0].consultas_realizada) || 0;
    
    
    // Verificar cache
    const [cacheRows] = await pool.query(
      `SELECT * FROM consultas_api
       WHERE numero_documento = ? AND numero_beneficio = ?
       ORDER BY data_hora_registro DESC
       LIMIT 1`,
      [rawCPF, rawNB]
    );
    let newRecord;
    if (cacheRows.length > 0) {
        const cacheRecord = cacheRows[0];
        if (cacheRecord.nome === null)
             return res.status(400).json({ error: 'Nome não encontrado na API, consulta não consumida.' });
      const recordDate = new Date(cacheRecord.data_hora_registro);
      const diffDays = (new Date() - recordDate) / (1000 * 60 * 60 * 24);
      if (diffDays < 30) {
        const duplicateQuery = `
          INSERT INTO consultas_api (
            id_usuario,
            numero_beneficio,
            numero_documento,
            nome,
            estado,
            pensao,
            data_nascimento,
            tipo_bloqueio,
            data_concessao,
            tipo_credito,
            limite_cartao_beneficio,
            saldo_cartao_beneficio,
            limite_cartao_consignado,
            saldo_cartao_consignado,
            situacao_beneficio,
            data_final_beneficio,
            saldo_credito_consignado,
            saldo_total_maximo,
            saldo_total_utilizado,
            saldo_total_disponivel,
            data_consulta,
            data_retorno_consulta,
            hora_retorno_consulta,
            nome_representante_legal,
            banco_desembolso,
            agencia_desembolso,
            conta_desembolso,
            digito_desembolso,
            numero_portabilidades,
            data_hora_registro,
            nome_arquivo
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)
        `;
        const nomeArquivo = 'consulta_europa_individual';
        const dupValues = [
          userId,
          cacheRecord.numero_beneficio,
          cacheRecord.numero_documento,
          cacheRecord.nome,
          cacheRecord.estado,
          cacheRecord.pensao,
          cacheRecord.data_nascimento,
          cacheRecord.tipo_bloqueio,
          cacheRecord.data_concessao,
          cacheRecord.tipo_credito,
          cacheRecord.limite_cartao_beneficio,
          cacheRecord.saldo_cartao_beneficio,
          cacheRecord.limite_cartao_consignado,
          cacheRecord.saldo_cartao_consignado,
          cacheRecord.situacao_beneficio,
          cacheRecord.data_final_beneficio,
          cacheRecord.saldo_credito_consignado,
          cacheRecord.saldo_total_maximo,
          cacheRecord.saldo_total_utilizado,
          cacheRecord.saldo_total_disponivel,
          cacheRecord.data_consulta,
          cacheRecord.data_retorno_consulta,
          cacheRecord.hora_retorno_consulta,
          cacheRecord.nome_representante_legal,
          cacheRecord.banco_desembolso,
          cacheRecord.agencia_desembolso,
          cacheRecord.conta_desembolso,
          cacheRecord.digito_desembolso,
          cacheRecord.numero_portabilidades,
          nomeArquivo
          ];
        const [dupResult] = await pool.query(duplicateQuery, dupValues);
        const [newRows] = await pool.query('SELECT * FROM consultas_api WHERE id = ?', [dupResult.insertId]);
        newRecord = newRows[0];
      }
    }
    if (!newRecord) {
      const apiUrl = 'https://api.ajin.io/v3/query-inss-balances/finder/await';
      const apiKey = process.env.TOKEN_QUALIBANKING || '';
      if (!apiKey) {
        return res.status(500).json({ error: 'API key não configurada.' });
      }

      // Espera 3 segundos antes da chamada


      const apiResponse = await axios.post(
        apiUrl,
        {
          identity: rawCPF,
          benefitNumber: rawNB,
          lastDays: 0,
          attemps: 120
        },
        {
          headers: {
            apiKey: apiKey,
            'Content-Type': 'application/json',
            }
          }
      );

        // Espera 3 segundos depois da chamada
        await new Promise(resolve => setTimeout(resolve, 3000));


      if (apiResponse.status !== 200) {
        return res.status(500).json({ error: 'Erro ao consultar API externa.' });
      }
      const apiData = apiResponse.data;
      const dataNascimento = convertDate(apiData.birthDate);
      const dataConcessao = convertDate(apiData.grantDate);
      const dataFinalBeneficio = convertDate(apiData.benefitEndDate);
      const dataConsulta = convertDate(apiData.queryDate);
      const dataRetornoConsulta = convertDate(apiData.queryReturnDate);
        const insertQuery = `
        INSERT INTO consultas_api (
          id_usuario,
          numero_beneficio,
          numero_documento,
          nome,
          estado,
          pensao,
          data_nascimento,
          tipo_bloqueio,
          data_concessao,
          tipo_credito,
          limite_cartao_beneficio,
          saldo_cartao_beneficio,
          limite_cartao_consignado,
          saldo_cartao_consignado,
          situacao_beneficio,
          data_final_beneficio,
          saldo_credito_consignado,
          saldo_total_maximo,
          saldo_total_utilizado,
          saldo_total_disponivel,
          data_consulta,
          data_retorno_consulta,
          hora_retorno_consulta,
          nome_representante_legal,
          banco_desembolso,
          agencia_desembolso,
          conta_desembolso,
          digito_desembolso,
          numero_portabilidades,
          data_hora_registro,
          nome_arquivo
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)
        `;
      const nomeArquivo = 'consulta_europa_individual';
      const values = [
        userId,
        rawNB,
        rawCPF,
        apiData.name,
        apiData.state,
        apiData.alimony,
        dataNascimento,
        apiData.blockType,
        dataConcessao,
        apiData.creditType,
        apiData.benefitCardLimit,
        apiData.benefitCardBalance,
        apiData.consignedCardLimit,
        apiData.consignedCardBalance,
        apiData.benefitStatus,
        dataFinalBeneficio,
        apiData.consignedCreditBalance,
        apiData.maxTotalBalance,
        apiData.usedTotalBalance,
        apiData.benefitCardBalance,
        dataConsulta,
        dataRetornoConsulta,
        apiData.queryReturnTime,
        apiData.legalRepresentativeName,
        apiData.disbursementBankAccount?.bank ?? null,
        apiData.disbursementBankAccount?.branch ?? null,
        apiData.disbursementBankAccount?.number ?? null,
        apiData.disbursementBankAccount?.digit ?? null,
        apiData.numberOfActiveSuspendedReservations,
        nomeArquivo
        ];
      const [result] = await pool.query(insertQuery, values);
      const [newRows] = await pool.query('SELECT * FROM consultas_api WHERE id = ?', [result.insertId]);
      newRecord = newRows[0];
      if (newRecord.nome === null) {
          return res.status(400).json({ error: 'Nome não encontrado na API, consulta não consumida.' });
      }
    }

    if (newRecord) {
        if (limiteDisp <= 0) {
            return res.status(400).json({ error: 'Créditos esgotados para este usuário.' });
        }
        limiteDisp -= 1;
        consultasReal += 1;
        await pool.query('UPDATE creditos SET limite_disponivel = ?, consultas_realizada = ? WHERE id_user = ?', [limiteDisp, consultasReal, userId]);
    }

    return res.json({ consultas_api: newRecord, limite_disponivel: limiteDisp, consultas_realizada: consultasReal }); // Return updated counts
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno no servidor ao processar a consulta.' });
  }
});

app.listen(port, () => {
  console.log(`Servidor de API rodando na porta ${port}`);
});

export default app;