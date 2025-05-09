import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs'; // Importar bcrypt
import cors from 'cors';



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
const saltRounds = 10; // Definir o número de salt rounds para bcrypt

app.use(express.json());
app.use(express.static('public'));

// Middleware manual de CORS para garantir em produção
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://consulta-in100.vercel.app');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Configuração do CORS (pode ser mantida para uso local)
app.use(cors({
  origin: ['https://consulta-in100.vercel.app', 'http://localhost:3000','http://localhost:5173']
}));

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
                  attemps: 60
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
  connectionLimit: 1000,
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

        // Comparar a senha fornecida com o hash no banco de dados
        const match = await bcrypt.compare(senha, user.senha);
        if (!match) {
            return res.status(401).json({ error: 'Senha incorreta' });
        }


        await pool.query('UPDATE usuarios SET ultimo_log = NOW() WHERE id = ?', [user.id]);
        const creditos = await calculateUserCredits(user.id);
        delete user.senha; // Não retornar a senha (mesmo hash)
        user.creditos = creditos;
        return res.json(user);
    } catch (error) {
        console.error('Erro ao realizar login:', error);
        return res.status(500).json({ error: 'Erro ao processar login' });
    }
});

// Rota de CADASTRO
app.post('/api/cadastro', async (req, res) => { // Tornar a função async
  const { nome, login, senha } = req.body;

  // Validar entrada
  if (!nome || !login || !senha) {
    return res.status(400).json({ error: 'Nome, login e senha são obrigatórios.' });
  }

  try {
    // Verificar se o login já existe
    const [existingUser] = await pool.query('SELECT id FROM usuarios WHERE login = ? LIMIT 1', [login]);
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'Login já cadastrado.' }); // 409 Conflict
    }

    // Criptografar a senha
    const hashedSenha = await bcrypt.hash(senha, saltRounds);

    // Inserir no banco de dados
    const query = 'INSERT INTO usuarios (nome, login, senha, data_criacao) VALUES (?, ?, ?, NOW())';
    const [result] = await pool.query(query, [nome, login, hashedSenha]);

    // Log e resposta de sucesso
    console.log('Usuário cadastrado com sucesso. ID:', result.insertId);
    res.status(201).json({ message: 'Usuário cadastrado com sucesso!', userId: result.insertId }); // 201 Created

  } catch (error) {
    console.error('Erro ao cadastrar usuário:', error);
    // Verificar se o erro é de chave duplicada (embora a verificação anterior deva pegar isso)
    if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Login já cadastrado.' });
    }
    return res.status(500).json({ error: 'Erro interno ao cadastrar usuário.' });
  }
});

// GET /api/usuarios - retorna todos os usuários
app.get('/api/usuarios', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios');
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar usuários:', error);
    res.status(500).json({ error: 'Erro ao buscar usuários.' });
  }
});

// GET /api/creditos - retorna todos os créditos
app.get('/api/creditos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM creditos');
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar créditos:', error);
    res.status(500).json({ error: 'Erro ao buscar créditos.' });
  }
});

// Rota para ALTERAR SENHA
app.post('/api/alterar', async (req, res) => {
  const { login, novaSenha } = req.body;

  // Validar entrada
  if (!login || !novaSenha) {
    return res.status(400).json({ error: 'Login e nova senha são obrigatórios.' });
  }

  try {
    // Verificar se o usuário existe
    const [userRows] = await pool.query('SELECT id FROM usuarios WHERE login = ? LIMIT 1', [login]);

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    // Criptografar a nova senha
    const hashedNovaSenha = await bcrypt.hash(novaSenha, saltRounds);

    // Atualizar a senha no banco de dados
    const updateQuery = 'UPDATE usuarios SET senha = ? WHERE login = ?';
    const [result] = await pool.query(updateQuery, [hashedNovaSenha, login]);

    if (result.affectedRows === 0) {
        // Isso não deveria acontecer se a verificação acima funcionou, mas é uma segurança extra
        return res.status(404).json({ error: 'Usuário não encontrado para atualização.' });
    }

    console.log(`Senha alterada com sucesso para o login: ${login}`);
    res.status(200).json({ message: 'Senha alterada com sucesso!' });

  } catch (error) {
    console.error('Erro ao alterar senha:', error);
    return res.status(500).json({ error: 'Erro interno ao alterar senha.' });
  }
});

// Rota para CARREGAR CRÉDITOS
app.post('/api/carregar', async (req, res) => {
  const { id_user, login, total_carregado } = req.body;

  if (!id_user || !login || !total_carregado) {
    return res.status(400).json({ error: 'ID de usuário, login e total carregado são obrigatórios.' });
  }

  try {
    // Verificar se o usuário existe
    const [userRows] = await pool.query('SELECT id FROM usuarios WHERE id = ? AND login = ? LIMIT 1', [id_user, login]);
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    // Calcular limite disponível (igual ao total carregado inicialmente)
    const limite_disponivel = total_carregado;

    // Inserir créditos
    const insertQuery = `
      INSERT INTO creditos (id_user, login, total_carregado, limite_disponivel, consultas_realizada)
      VALUES (?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
      total_carregado = total_carregado + VALUES(total_carregado),
      limite_disponivel = limite_disponivel + VALUES(limite_disponivel);
    `;
    await pool.query(insertQuery, [id_user, login, total_carregado, limite_disponivel]);

    // Buscar o novo valor de créditos para retornar
    const creditos = await calculateUserCredits(id_user);

    console.log(`Créditos carregados para o usuário com ID: ${id_user}, Login: ${login}, Total Carregado: ${total_carregado}`);
    res.status(200).json({ message: 'Créditos carregados com sucesso!', creditos: creditos });

  } catch (error) {
    console.error('Erro ao carregar créditos:', error);
    return res.status(500).json({ error: 'Erro interno ao carregar créditos.' });
  }
});





// Rota de CONSULTA
// --- Fila por CPF+NB para serializar consultas simultâneas do mesmo benefício ---
const consultasQueues = {}; // { 'cpf-nb': [{ req, res }] }
const consultasEmAndamento = {}; // { 'cpf-nb': boolean }

function getConsultaKey(cpf, nb) {
  return `${sanitizeDoc(cpf)}-${sanitizeDoc(nb)}`;
}

async function processaFilaConsulta2(key) {
  if (consultasEmAndamento[key] || !consultasQueues[key] || consultasQueues[key].length === 0) return;
  consultasEmAndamento[key] = true;
  const { req, res } = consultasQueues[key].shift();
  try {
    await consultaHandlerFila2(req, res);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno ao processar consulta.' });
  } finally {
    consultasEmAndamento[key] = false;
    setImmediate(() => processaFilaConsulta2(key));
  }
}

app.post('/api/consulta', async (req, res) => {
  const { cpf, nb } = req.body;
  if (!cpf || !nb) {
    return res.status(400).json({ error: 'CPF e NB são obrigatórios.' });
  }
  const rawCPF = sanitizeDoc(cpf);
  const rawNB = sanitizeDoc(nb);
  try {
    const result = await consultarApiComRetentativa(rawCPF, rawNB);
    if (result.status === 200) {
      return res.status(200).json(result.data);
    } else {
      return res.status(500).json({ error: result.error || 'Erro ao consultar API externa.' });
    }
  } catch (error) {
    console.error('Erro ao consultar API:', error);
    return res.status(500).json({ error: 'Erro interno ao consultar API.' });
  }
});

// Handler para a fila da /api/consulta2 (SEM consulta à tabela consultas_api, sempre consulta a API externa)
async function consultaHandlerFila2(req, res) {
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
      'SELECT limite_disponivel, consultas_realizada FROM creditos WHERE id_user = ? ORDER BY data_saldo_carregado DESC LIMIT 1',
      [userId]
    );
    if (creditRows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma operação de crédito encontrada para este usuário.' });
    }
    let limiteDisp = Number(creditRows[0].limite_disponivel) || 0;
    let consultasReal = Number(creditRows[0].consultas_realizada) || 0;

    // Sempre consulta a API externa
    const apiUrl = 'https://api.ajin.io/v3/query-inss-balances/finder/await';
    const apiKey = process.env.TOKEN_QUALIBANKING || '';
    if (!apiKey) {
      return res.status(500).json({ error: 'API key não configurada.' });
    }

    // Espera 3 segundos antes da chamada (remova se não for obrigatório)
    await new Promise(resolve => setTimeout(resolve, 3000));

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

    // Espera 3 segundos depois da chamada (remova se não for obrigatório)
    await new Promise(resolve => setTimeout(resolve, 3000));

    if (apiResponse.status !== 200) {
      return res.status(500).json({ error: 'Erro ao consultar API externa.' });
    }
    const apiData = apiResponse.data;
    if (!apiData.name) {
      return res.status(400).json({ error: 'Nome não encontrado na API, consulta não consumida.' });
    }
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
      Number(apiData.benefitCardLimit),
      Number(apiData.benefitCardBalance),
      Number(apiData.consignedCardLimit),
      Number(apiData.consignedCardBalance),
      apiData.benefitStatus,
      dataFinalBeneficio,
      Number(apiData.consignedCreditBalance),
      Number(apiData.maxTotalBalance),
      Number(apiData.usedTotalBalance),
      Number(apiData.benefitCardBalance), // saldo_total_disponivel
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
    const newRecord = newRows[0];

    if (limiteDisp <= 0) {
      return res.status(400).json({ error: 'Créditos esgotados para este usuário.' });
    }
    limiteDisp -= 1;
    consultasReal += 1;
    await pool.query('UPDATE creditos SET limite_disponivel = ?, consultas_realizada = ? WHERE id_user = ?', [limiteDisp, consultasReal, userId]);

    return res.json({ consultas_api: newRecord, limite_disponivel: limiteDisp, consultas_realizada: consultasReal });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno no servidor ao processar a consulta.' });
  }
}

// Handler para a fila da /api/consulta2 (busca apenas no banco de dados, sem consultar API externa)
async function consultaHandlerFila2Cache(req, res) {
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
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    const userId = userRows[0].id;

    // Buscar créditos do usuário
    const [creditRows] = await pool.query(
      'SELECT limite_disponivel, consultas_realizada FROM creditos WHERE id_user = ? ORDER BY data_saldo_carregado DESC LIMIT 1',
      [userId]
    );
    let limiteDisp = null;
    let consultasReal = null;
    if (creditRows.length > 0) {
      limiteDisp = Number(creditRows[0].limite_disponivel) || 0;
      consultasReal = Number(creditRows[0].consultas_realizada) || 0;
    }

    // Buscar consulta no banco
    const [rows] = await pool.query(
      `SELECT * FROM consultas_api
       WHERE numero_documento = ? AND numero_beneficio = ?
       ORDER BY data_hora_registro DESC
       LIMIT 1`,
      [rawCPF, rawNB]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        warning: true,
        message: 'Nenhum dado encontrado. Realize a consulta ON para obter informações atualizadas.',
        limite_disponivel: limiteDisp,
        consultas_realizada: consultasReal
      });
    }

    // Se não tiver nome, retorna aviso
    if (!rows[0].nome) {
      return res.status(200).json({
        consultas_api: rows[0],
        cache: true,
        warning: true,
        message: 'Consulta encontrada, mas sem nome cadastrado. É necessário realizar a consulta ON para obter os dados completos.',
        limite_disponivel: limiteDisp,
        consultas_realizada: consultasReal
      });
    }

    // Caso tenha nome, retorna normalmente
    return res.json({
      consultas_api: rows[0],
      cache: true,
      limite_disponivel: limiteDisp,
      consultas_realizada: consultasReal
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno ao buscar consulta no banco.' });
  }
}

// Fila para /api/consulta2 (apenas cache)
async function processaFilaConsulta2Cache(key) {
  if (consultasEmAndamento[key] || !consultasQueues[key] || consultasQueues[key].length === 0) return;
  consultasEmAndamento[key] = true;
  const { req, res } = consultasQueues[key].shift();
  try {
    await consultaHandlerFila2Cache(req, res);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno ao processar consulta.' });
  } finally {
    consultasEmAndamento[key] = false;
    setImmediate(() => processaFilaConsulta2Cache(key));
  }
}

// Nova rota para consulta apenas no banco
app.post('/api/consulta2', (req, res) => {
  const { cpf, nb } = req.body;
  const key = getConsultaKey(cpf, nb);
  if (!consultasQueues[key]) consultasQueues[key] = [];
  consultasQueues[key].push({ req, res });
  processaFilaConsulta2Cache(key);
});

// Rota para listar usuários
app.get('/api/userlogins', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT DISTINCT id, nome, login FROM usuarios'
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Nenhum usuário encontrado' });
        }
        return res.json(rows);
    } catch (error) {
        console.error('Erro ao listar usuários:', error);
        return res.status(500).json({ error: 'Erro ao processar listagem de usuários' });
    }
});

// Rota para consultar detalhes de um usuário específico
app.get('/api/userlogins/:id', async (req, res) => {
    const userId = req.params.id;
    try {
        const [rows] = await pool.query('SELECT id, nome, login FROM usuarios WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
        return res.json(rows[0]);
    } catch (error) {
        console.error('Erro ao buscar detalhes do usuário:', error);
        return res.status(500).json({ error: 'Erro ao processar detalhes do usuário' });
    }
});






app.listen(port, () => {
  console.log(`Servidor de API rodando na porta ${port}`);
});

export default app;
