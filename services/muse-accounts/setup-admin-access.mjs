import {openAdminAccess} from './admin-access.mjs';
const root=process.argv[2];if(!root)throw Error('Provide private credential directory');
let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>512)throw Error('Input too long');}
await (await openAdminAccess(root)).configure(value.trim());console.log('Administrator credential configured; value not displayed.');
