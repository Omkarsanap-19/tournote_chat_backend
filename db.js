const db = require('pg');
require('dotenv').config();



const pool = new db.Pool({
    connectionString:process.env.DATABASE_URL,
    ssl:{
        rejectUnauthorized : false
    }
});

pool.connect().then(()=>(console.log('db is connected..')
)).catch(()=>(console.log('db is not connected..')
))

module.exports = pool