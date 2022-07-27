import { SlashCommandBuilder } from "@discordjs/builders";
import { Channel, Message, MessageButton, MessageEmbed } from "discord.js";

import { BOARD_CHANNEL, boardMessageToSource, MIN_REACTIONS } from "../common/board.js";
import CONSTANTS from "../common/CONSTANTS.js";
import asyncFilter from "../lib/asyncFilter.js";
import firstPromiseValued from "../lib/firstPromiseValued.js";
import generateHash from "../lib/generateHash.js";
import getAllMessages from "../lib/getAllMessages.js";

/**
 * Determine if a text-based channel is a match of a guild-based channel.
 *
 * @param {import("discord.js").GuildBasedChannel} channelWanted - Guild based channel.
 * @param {import("discord.js").AnyChannel} channelFound - Text based channel.
 *
 * @returns {Promise<boolean>} Whether the channel is a match.
 */
async function textChannelMatches(channelWanted, channelFound) {
	switch (channelWanted.type) {
		case "GUILD_TEXT":
		case "GUILD_NEWS":
		case "GUILD_VOICE": {
			// Text

			if (channelFound.id === channelWanted.id) return true;

			return channelFound.isThread() && channelFound.parent?.id === channelWanted.id;
		}
		case "GUILD_CATEGORY": {
			// category
			const promises = [];

			for (const channel of channelWanted.children.values())
				promises.push(textChannelMatches(channel, channelFound));

			return await firstPromiseValued(true, promises);
		}
		case "GUILD_NEWS_THREAD":
		case "GUILD_PUBLIC_THREAD":
		case "GUILD_PRIVATE_THREAD": {
			// thread
			return channelWanted.id === channelFound.id;
		}

		default: {
			// It’s likely a stage
			return false;
		}
	}
}

/** @type {import("../types/command").default} */
const info = {
	data: new SlashCommandBuilder()
		.setDescription("Replies with a random message from the potatoboard.")
		.addIntegerOption((input) =>
			input
				.setName("minimum-reactions")
				.setDescription(
					"Filter messages to only get those with at least this many reactions.",
				)
				.setRequired(false)
				.setMinValue(MIN_REACTIONS),
		)
		.addUserOption((input) =>
			input
				.setName("user")
				.setDescription("Filter messages to only get those by a certain user.")
				.setRequired(false),
		)
		.addChannelOption((input) =>
			input
				.setName("channel")
				.setDescription("Filter messages to only get those in a certain channel.")
				.setRequired(false)
				.addChannelTypes(
					0, // GuildText
					2, // GuildVoice
					4, // GuildCategory
					5, // GuildNews
					10, // GuildNewsThread
					11, // GuildPublicThread
					12, // GuildPrivateThread
				),
		),

	async interaction(interaction) {
		if (interaction.guild?.id !== process.env.GUILD_ID) return;

		const deferPromise = interaction.deferReply({
			ephemeral: interaction.channel?.id !== process.env.BOTS_CHANNEL,
		});
		const board = await interaction.guild?.channels.fetch(BOARD_CHANNEL);

		if (!board?.isText()) {
			throw new ReferenceError("Could not find board channel.");
		}

		const minReactions = interaction.options.getInteger("minimum-reactions") || 0;
		const user = interaction.options.getUser("user")?.id;
		const channel = interaction.options.getChannel("channel");
		const channelWanted =
			channel &&
			(channel instanceof Channel
				? channel
				: await interaction.guild?.channels.fetch(channel.id).catch(() => {}));
		if (channel && !channelWanted)
			throw new ReferenceError(`Could not find referenced channel ${channel.id}`);
		const [, fetchedMessages] = await Promise.all([
			deferPromise,
			getAllMessages(board).then((messages) =>
				asyncFilter(
					messages
						.filter((message) => {
							if (
								!message.content ||
								!message.embeds[0] ||
								!message.author.bot ||
								(/\d+/.exec(message.content)?.[0] || 0) < minReactions
							)
								return false;
							return message;
						})
						.sort(() => Math.random() - 0.5),
					async (message) => {
						const source = await boardMessageToSource(message);

						if (
							user &&
							source?.author.id !== user &&
							message.mentions.users.first()?.id !== user
						)
							return false;

						const channelFound = source?.channel || message.mentions.channels.first();

						if (
							channelWanted &&
							channelFound &&
							!(await textChannelMatches(channelWanted, channelFound))
						)
							return false;

						return message;
					},
				),
			),
		]);

		const nextButton = new MessageButton()
			.setLabel("Next")
			.setCustomId(generateHash("next"))
			.setStyle("SECONDARY")
			.setEmoji("➡");

		let source = (await fetchedMessages.next()).value;
		/**
		 * Grab a new message from the board.
		 *
		 * @param {void | Message<boolean>} current
		 *
		 * @returns {Promise<import("discord.js").InteractionReplyOptions>} - Reply to post next.
		 */
		async function generateMessage(current) {
			if (!current?.components[0]?.components[0]) {
				return {
					allowedMentions: { users: [] },
					files: [],
					components: [],

					content: `${CONSTANTS.emojis.statuses.no} No messages found. Try changing any filters you may have used.`,

					embeds: [],
					ephemeral: true,
				};
			}
			source = (await fetchedMessages.next()).value;

			if (!source?.components[0]?.components[0]) nextButton.setDisabled(true);

			return {
				allowedMentions: { users: [] },

				components: [
					current.components[0]?.components[0]
						? current.components[0]?.setComponents(
								current.components[0].components[0],
								nextButton,
						  )
						: current.components[0],
				],

				content: current.content,
				embeds: current.embeds.map((oldEmbed) => new MessageEmbed(oldEmbed)),
				ephemeral: interaction.channel?.id !== process.env.BOTS_CHANNEL,
				files: current.attachments.map((attachment) => attachment),
			};
		}

		await interaction.editReply(await generateMessage(source));

		const collector = interaction.channel?.createMessageComponentCollector({
			filter: (buttonInteraction) =>
				buttonInteraction.customId === nextButton.customId &&
				buttonInteraction.user.id === interaction.user.id,

			time: 30_000,
		});

		collector
			?.on("collect", async (buttonInteraction) => {
				buttonInteraction.deferUpdate();
				await interaction.editReply(await generateMessage(source));

				collector.resetTimer();
			})
			.on("end", async () => {
				const source = await interaction.fetchReply();

				if (!(source instanceof Message)) throw new TypeError("Source is not a message.");

				await interaction.editReply({
					allowedMentions: { users: [] },

					components: source.components.map((components) =>
						components.setComponents(
							components.components.map(
								(component) =>
									component.setDisabled(
										!(component.type === "BUTTON" && component.url),
									),
								// Disable it if it’s not a button with a URL
							),
						),
					),

					content: source.content,
					embeds: source.embeds.map((oldEmbed) => new MessageEmbed(oldEmbed)),
					files: source.attachments.map((attachment) => attachment),
				});
			});
	},
};

export default info;
