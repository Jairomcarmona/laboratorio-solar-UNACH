/* Configuracion de despliegue. En el servidor este archivo se reemplaza (ver server/deploy/): source 'ws' usa el banco real.
 * source: 'sim' (simulador local, sin red) | 'ws' (banco real por la pasarela) | 'twin' | 'replay'. Se puede forzar con ?source=. */
window.LAB = window.LAB || {};
LAB.deploy = { source: 'sim', apiBase: '', loginUrl: 'login.html' };
