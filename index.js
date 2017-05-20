const async = require('async');
const chalk = require('chalk');
const got = require('got');
const mongodb = require('mongodb');
const mongodbLock = require('mongodb-lock');
const sntp = require('sntp');
const sugarDate = require('sugar-date');

const config = require('./config.json');

const userRegex = new RegExp(`@${config.github.username}`, 'ig');
const userDateRegex = new RegExp(`^[\\t\\s]*@${config.github.username}[\\t\\s]+([^\\r\\n]+?)(?:[\\t\\s]+to[\\t\\s]*[^\\r\\n]*)?$`, 'igum');
const userLower = `@${config.github.username}`.toLowerCase();

const ghAuth = {
	auth: `${config.github.username}:${config.github.token}`,
	headers: {
		'User-Agent': `${config.github.userAgent}`,
		Accept: 'application/vnd.github.squirrel-girl-preview'
	}
};

const mdbConnectString = `mongodb://${config.mongo.username}:${config.mongo.password}@${config.mongo.host}/${config.mongo.database}`;

const log = {
	info: (...args) => console.log(chalk.magenta('INFO:'), ...args),
	warn: (...args) => console.warn(chalk.yellow.bold('WARNING:'), ...args),
	error: (...args) => console.error(chalk.red.bold('ERROR:'), ...args),
	inspect: arg => console.log(require('util').inspect(arg, {colors: true, depth: null}))
};

function parseDate(body) {
	body = body.replace(/^[\s\t]*(at|on)[\s\t]+/, '');
	const date = sugarDate.Date.create(body, {future: true, past: false, fromUTC: true});
	if (date.getTime() <= Date.now()) {
		return new Date(NaN);
	}
	return date;
}

mongodb.MongoClient.connect(mdbConnectString, (err, db) => {
	if (err) {
		throw err;
	}

	log.info('connected to database');

	const lock = mongodbLock(db, 'locks', 'process-notifications', {timeout: 120 * 1000});

	function processNotifications(cb) {
		async.waterfall([
			// Get the time from a dedicated NTP server (so we're always in sync)
			// cb => sntp.time({}, cb),
			// (timestamp, cb) => cb(null, timestamp.receivedLocally),

			// Get new notifications
			cb => got('https://api.github.com/notifications', ghAuth)
				.then(response => cb(null, JSON.parse(response.body)))
				.catch(cb),

			// Filter notifications to only accept mentions
			(notifications, cb) => cb(null, notifications.filter(n => n.reason === 'mention')),

			// Convert threads to groups of comments (includes issues, issue comments and PR comments all in one)
			(notifications, cb) => async.map(notifications,
				(n, cb) => got(`${n.subject.url}/comments`, ghAuth)
					.then(response => cb(null, JSON.parse(response.body)))
					.catch(cb),
				(err, results) => cb(err, notifications, results)),

			// Pool together all threads' comments into a single array
			(notifications, pools, cb) => cb(null, notifications, pools.reduce((arr, p) => arr.concat(p), [])),

			// De-duplicate comments by ID
			(notifications, comments, cb) => {
				const uniqued = comments.reduce((obj, c) => {
					obj[c.id] = c;
					return obj;
				}, {});

				const unique = [];
				for (const k of Object.keys(uniqued)) {
					unique.push(uniqued[k]);
				}

				cb(null, notifications, unique);
			},

			// Filter out comments with no mentions
			(notifications, comments, cb) => cb(null, notifications, comments.filter(c => c.body.search(userRegex) !== -1)),

			// Filter out comments that have already been reacted to (by us)
			(notifications, comments, cb) => async.reject(comments,
				(c, cb) => got(`${c.url}/reactions`, ghAuth)
					.then(response => {
						const reactions = JSON.parse(response.body);

						for (const reaction of reactions) {
							if (reaction.user.login.toLowerCase() === userLower) {
								return cb(null, true);
							}
						}

						cb(null, false);
					})
					.catch(cb),
				(err, results) => cb(err, notifications, results)),

			// Parse comments for username mentions; merge results into record
			(notifications, comments, cb) => cb(null, notifications, comments.map(
				c => {
					c.validDates = []; // Date objects
					c.invalidDates = []; // Bad strings
					let match = null;
					while ((match = userDateRegex.exec(c.body))) {
						const date = parseDate(match[1]);
						if (isNaN(date.getTime())) {
							c.invalidDates.push(match[1]);
						} else {
							c.validDates.push(date);
						}
					}
					return c;
				})),

			// Convert each comment to action ({reaction: 'up'/'down', comment: null/'some response', record: mongodb_record, analytics: {...}})
			(notifications, comments, cb) => cb(null, notifications, comments.map(
				c => {
					const action = {
						reactions: [], // Make sure to have at least one, or else it'll send a million messages.
						comment: null,
						record: null,
						analytics: null
					};
					c.remindAction = action;

					// Dates


					// TODO Mongo record
					// TODO Analytics

					return c;
				})),

			(notifications, comments, cb) => {
				log.inspect(comments);
				cb();
			},

			// TODO Parallel: Send Reaction + Comment / Mark as read / Commit record / Send analytics

			// Report rate limit
			cb => got('https://api.github.com/rate_limit', ghAuth)
				.then(response => cb(null, JSON.parse(response.body)))
				.catch(cb),
			(limits, cb) => {
				log.info(`${chalk.dim('rate limiting:')} ${chalk.bold(limits.rate.remaining)} out of ${chalk.bold(limits.rate.limit)} remaining; resets at ${chalk.bold(limits.rate.reset)}`);
				cb();
			}
		], cb);
	}

	function checkAll() {
		async.waterfall([
			// Acquire a lock
			cb => lock.acquire((err, code) => {
				if (err) {
					return cb(err);
				}
				log.info('acquired lock');
				cb(null, code);
			}),

			// Perform update tick
			(code, cb) => processNotifications(err => cb(err, code)),

			// Release lock
			(code, cb) => lock.release(code, (err, ok) => {
				if (err) {
					return cb(err);
				}

				if (ok) {
					log.info('released lock');
				} else {
					log.warn('could not release lock!');
				}

				cb();
			})
		], err => {
			if (err) {
				log.error(`${err.stack || err.toString()}`);
				if (err.response) {
					log.inspect(JSON.parse(err.response.body));
				}
			}

			setTimeout(checkAll, config.interval);
		});
	}

	checkAll();
});
