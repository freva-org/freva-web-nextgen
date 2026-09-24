// Preloaded into a child process to make every outbound network call fail. A build that quietly
// reaches the network is the failure mode this design avoids, so the check has to be a real
// denial rather than an inspection of what the code appears to do.

const net = require("node:net");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

const deny = (what) => {
  const error = new Error(`network denied: ${what}`);
  error.code = "ENETUNREACH";
  throw error;
};

net.Socket.prototype.connect = function denied() {
  deny("net.Socket.connect");
};
net.connect = () => deny("net.connect");
net.createConnection = () => deny("net.createConnection");
tls.connect = () => deny("tls.connect");
dns.lookup = (_hostname, _options, callback) => {
  const cb = typeof _options === "function" ? _options : callback;
  const error = new Error("network denied: dns.lookup");
  error.code = "ENOTFOUND";
  if (cb) cb(error);
  else throw error;
};
dns.promises.lookup = async () => deny("dns.promises.lookup");
http.request = () => deny("http.request");
https.request = () => deny("https.request");
http.get = () => deny("http.get");
https.get = () => deny("https.get");
globalThis.fetch = async () => deny("fetch");
