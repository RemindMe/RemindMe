const fs = require('fs');

const async = require('async');
const chalk = require('chalk');
const got = require('got');
const mongodb = require('mongodb');
const mongodbLock = require('mongodb-lock');
const pegjs = require('pegjs');
const sntp = require('sntp');

// const parser = pegjs.generate(fs.readFileSync('./remind.pegjs', 'utf8'));
const config = require('./config.json');

const ghAuth = {auth: `${config.github.username}:${config.github.token}`};
const mdbConnectString = `mongodb://${config.mongo.username}:${config.mongo.password}@${config.mongo.host}/${config.mongo.database}`;

const log = {
	info: (...args) => console.log(chalk.magenta('INFO:'), ...args),
	warn: (...args) => console.warn(chalk.yellow.bold('WARNING:'), ...args),
	error: (...args) => console.error(chalk.red.bold('ERROR:'), ...args)
};

mongodb.MongoClient.connect(mdbConnectString, (err, db) => {
	if (err) {
		throw err;
	}

	log.info('connected to database');

	const lock = mongodbLock(db, 'locks', 'process-notifications', {timeout: 120 * 1000});

//	function notificationToComments(time, db, notification, cb) {
//		const markAsRead = (comments) => got.patch(notification.url, ghAuth)
//			.then(() => got.delete(notification.subscription_url, ghAuth)
//				.then(() => cb(null, comments))
//				.catch(cb))
//			.catch(cb);
//
//		if (notification.reason === 'mention') {
//			got(notification.subject.url + '/comments', ghAuth)
//				.then(response => cb(
//		} else {
//			return markAsRead([]);
//		}
//	}

	function processNotifications(cb) {
		async.waterfall([
			// Get the time from a dedicated NTP server (so we're always in sync)
			cb => sntp.time({}, cb),
			(timestamp, cb) => cb(null, timestamp.receivedLocally),

			// Get last notifications
			(timestamp, cb) => got('https://api.github.com/notifications', ghAuth)
				.then(response => cb(null, timestamp, JSON.parse(response.body)))
				.catch(cb),

			// TODO Filter notifications to only accept mentions
			// TODO Convert threads to groups of comments (includes issues, issue comments and PR comments all in one)
			// TODO Pool together all threads' comments into a single array
			// TODO De-duplicate comments by ID
			// TODO Parse comments for @RemindMe mentions; merge results into record
			// TODO Filter out comments with no mentions
			// TODO Query and merge reaction information to each comment
			// TODO Filter out comments that have already been reacted to (by us)
			// TODO Convert each comment to action ({reaction: 'up'/'down', comment: null/'some response', record: mongodb_record, analytics: {...}})
			// TODO Parallel: Send Reaction + Comment / Commit record / Send analytics
			(timestamp, notifications, cb) => cb(), // XXX

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

				if (!ok) {
					log.warn('could not release lock!');
				} else {
					log.info('released lock');
				}

				cb();
			})
		], err => {
			if (err) {
				log.error(`${err.stack || err.toString()}`);
			}

			setTimeout(checkAll, config.interval);
		});
	}

	checkAll();
});
