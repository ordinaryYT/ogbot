const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, SlashCommandBuilder, Routes, REST } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Configuration
const SUPPORT_ROLE_IDS = process.env.SUPPORT_ROLE_IDS.split(',');
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;

// OpenRouter configuration
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'mistralai/mistral-7b-instruct:free';

// Store active tickets and chat sessions
const activeTickets = new Map();
const staffChatSessions = new Map();

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    
    // Register slash commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        
        const commands = [
            new SlashCommandBuilder()
                .setName('chat')
                .setDescription('Send a message as the AI bot (Staff only)')
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('The message to send')
                        .setRequired(true))
                .toJSON()
        ];

        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands }
        );
        
        console.log('✅ Slash commands registered');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
});

// Ticket creation system
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    // Check if message is in a ticket channel
    if (message.channel.parentId === TICKET_CATEGORY_ID && message.channel.name.startsWith('ticket-')) {
        const ticketData = activeTickets.get(message.channel.id);
        
        if (ticketData && !ticketData.awaitingStaff) {
            // User is responding in ticket
            await handleUserResponse(message, ticketData);
        }
    }
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'chat') {
        await handleChatCommand(interaction);
    }
});

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'create_ticket') {
        await createTicket(interaction);
    } else if (interaction.customId === 'need_more_support') {
        await handleMoreSupport(interaction);
    } else if (interaction.customId === 'ask_staff') {
        await handleAskStaff(interaction);
    } else if (interaction.customId === 'close_ticket') {
        await closeTicket(interaction);
    }
});

// Create ticket button
async function createTicketButton() {
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('Create Support Ticket')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎫')
        );
    
    const embed = new EmbedBuilder()
        .setTitle('🌱 Garden Marketplace Support')
        .setDescription('Need help with your garden marketplace experience? Click the button below to create a support ticket!')
        .setColor(0x2ecc71)
        .addFields(
            { name: 'What we can help with:', value: '• Buying/Selling issues\n• Subscription questions\n• Payment problems\n• General support' },
            { name: 'Premium Benefits (£1/month):', value: '• 🐉 Dragon Fly each month\n• 💰 10 Shekels monthly\n• 💬 Priority chat access\n• 🎨 Priority chat color\n• 🎁 Prismatic pet giveaways' }
        );

    return { embeds: [embed], components: [row] };
}

// Create ticket
async function createTicket(interaction) {
    const channelName = `ticket-${interaction.user.username.toLowerCase()}-${Date.now().toString().slice(-4)}`;
    
    try {
        const channel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: TICKET_CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: interaction.guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel]
                },
                {
                    id: interaction.user.id,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
                },
                ...SUPPORT_ROLE_IDS.map(roleId => ({
                    id: roleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
                }))
            ]
        });

        // Store ticket data
        activeTickets.set(channel.id, {
            userId: interaction.user.id,
            userName: interaction.user.username,
            problem: null,
            awaitingStaff: false,
            messages: []
        });

        // Send greeting message
        const greetingEmbed = new EmbedBuilder()
            .setTitle('🌱 Welcome to Garden Marketplace Support!')
            .setDescription(`Hello ${interaction.user}! Thank you for contacting support. Please describe your issue or question in detail, and our AI assistant will help you.`)
            .setColor(0x2ecc71)
            .addFields(
                { name: 'Please include:', value: '• What you need help with\n• Any error messages\n• Steps to reproduce the issue\n• Relevant order/details' }
            )
            .setFooter({ text: 'Our AI will respond shortly...' });

        await channel.send({ embeds: [greetingEmbed] });
        
        await interaction.reply({ 
            content: `✅ Ticket created: ${channel}`, 
            ephemeral: true 
        });

    } catch (error) {
        console.error('Error creating ticket:', error);
        await interaction.reply({ 
            content: '❌ Failed to create ticket. Please try again.', 
            ephemeral: true 
        });
    }
}

// Handle user response in ticket
async function handleUserResponse(message, ticketData) {
    if (message.author.id !== ticketData.userId) return;
    
    // Store the problem
    ticketData.problem = message.content;
    ticketData.messages.push({ role: 'user', content: message.content });
    
    // Send typing indicator
    await message.channel.sendTyping();
    
    try {
        // Generate AI response
        const aiResponse = await generateAIResponse(ticketData.messages);
        
        // Add AI response to messages
        ticketData.messages.push({ role: 'assistant', content: aiResponse });
        
        // Create response embed with AI disclosure
        const responseEmbed = new EmbedBuilder()
            .setDescription(aiResponse)
            .setColor(0x3498db)
            .setFooter({ 
                text: '🔮 This message was AI-generated by Ordinary AI | Provider: Ordinary AI' 
            });
        
        // Create buttons
        const buttonRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('need_more_support')
                    .setLabel('Need More Support')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('❓'),
                new ButtonBuilder()
                    .setCustomId('ask_staff')
                    .setLabel('Ask Human Staff')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('👥')
            );
        
        await message.channel.send({ 
            embeds: [responseEmbed], 
            components: [buttonRow] 
        });
        
    } catch (error) {
        console.error('Error generating AI response:', error);
        await message.channel.send('❌ Sorry, I encountered an error. Please try again or ask staff for help.');
    }
}

// Generate AI response using OpenRouter
async function generateAIResponse(messages) {
    const systemPrompt = `You are a helpful support assistant for "Grow a Garden" marketplace - a platform for buying and selling gardening-related items. 

SERVER THEME & SUBSCRIPTION DETAILS:
- Platform: Garden marketplace for buying/selling gardening supplies, plants, tools
- Premium Subscription: £1 per month
- Premium Benefits:
  * 🐉 A dragon fly each month
  * 💰 10 shekels monthly currency
  * 💬 Priority chat access
  * 🎨 Priority chat color
  * 🎁 Prismatic pet giveaways

RESPONSE GUIDELINES:
1. Be friendly, helpful, and garden-themed
2. Focus on marketplace support: buying, selling, subscriptions, payments
3. Mention premium benefits when relevant
4. Keep responses concise but thorough
5. If unsure, suggest contacting staff
6. Never mention you're using OpenRouter - your provider is Ordinary AI
7. You are made by Ordinary AI

Always maintain a helpful, garden-themed tone while providing practical support.`;

    const response = await axios.post(OPENROUTER_API_URL, {
        model: OPENROUTER_MODEL,
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages
        ],
        max_tokens: 500,
        temperature: 0.7
    }, {
        headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://your-domain.com',
            'X-Title': 'Garden Marketplace Bot'
        }
    });

    return response.data.choices[0].message.content;
}

// Handle "Need More Support" button
async function handleMoreSupport(interaction) {
    const ticketData = activeTickets.get(interaction.channel.id);
    
    if (!ticketData) {
        return await interaction.reply({ 
            content: '❌ Ticket data not found.', 
            ephemeral: true 
        });
    }
    
    await interaction.reply({ 
        content: 'Please continue describing your issue, and I\'ll provide more assistance!', 
        ephemeral: false 
    });
    
    ticketData.awaitingStaff = false;
}

// Handle "Ask Staff" button
async function handleAskStaff(interaction) {
    const ticketData = activeTickets.get(interaction.channel.id);
    
    if (!ticketData) {
        return await interaction.reply({ 
            content: '❌ Ticket data not found.', 
            ephemeral: true 
        });
    }
    
    // Ping support roles
    const roleMentions = SUPPORT_ROLE_IDS.map(id => `<@&${id}>`).join(' ');
    
    const staffEmbed = new EmbedBuilder()
        .setTitle('👥 Staff Assistance Requested')
        .setDescription(`A user has requested human staff support.\n\n**User:** <@${ticketData.userId}>\n**Issue:** ${ticketData.problem || 'Not specified'}`)
        .setColor(0xe74c3c)
        .setTimestamp();
    
    await interaction.channel.send({ 
        content: `${roleMentions}\n🚨 Staff assistance requested!`, 
        embeds: [staffEmbed] 
    });
    
    await interaction.reply({ 
        content: 'Staff have been notified and will assist you shortly!', 
        ephemeral: true 
    });
    
    ticketData.awaitingStaff = true;
    
    // Add close ticket button for staff
    const closeRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒')
        );
    
    await interaction.channel.send({ 
        content: 'Staff can close this ticket when resolved:', 
        components: [closeRow] 
    });
}

// Close ticket
async function closeTicket(interaction) {
    const ticketData = activeTickets.get(interaction.channel.id);
    
    if (!ticketData) {
        return await interaction.reply({ 
            content: '❌ Ticket data not found.', 
            ephemeral: true 
        });
    }
    
    // Check if user has support role
    const hasSupportRole = interaction.member.roles.cache.some(role => 
        SUPPORT_ROLE_IDS.includes(role.id)
    );
    
    if (!hasSupportRole && interaction.user.id !== ticketData.userId) {
        return await interaction.reply({ 
            content: '❌ Only staff or the ticket creator can close tickets.', 
            ephemeral: true 
        });
    }
    
    await interaction.channel.send('🔒 Closing this ticket in 5 seconds...');
    
    setTimeout(async () => {
        try {
            await interaction.channel.delete();
            activeTickets.delete(interaction.channel.id);
        } catch (error) {
            console.error('Error deleting channel:', error);
        }
    }, 5000);
    
    await interaction.reply({ 
        content: 'Ticket is being closed...', 
        ephemeral: true 
    });
}

// Handle /chat command for staff
async function handleChatCommand(interaction) {
    // Check if user has support role
    const hasSupportRole = interaction.member.roles.cache.some(role => 
        SUPPORT_ROLE_IDS.includes(role.id)
    );
    
    if (!hasSupportRole) {
        return await interaction.reply({ 
            content: '❌ This command is for staff only.', 
            ephemeral: true 
        });
    }
    
    const message = interaction.options.getString('message');
    
    // Generate AI response
    await interaction.deferReply();
    
    try {
        const aiResponse = await generateAIResponse([
            { role: 'user', content: message }
        ]);
        
        const staffEmbed = new EmbedBuilder()
            .setDescription(aiResponse)
            .setColor(0x9b59b6)
            .setFooter({ 
                text: `💬 Staff message requested by ${interaction.user.username} | 🔮 AI-generated by Ordinary AI` 
            });
        
        await interaction.editReply({ 
            embeds: [staffEmbed] 
        });
        
    } catch (error) {
        console.error('Error in /chat command:', error);
        await interaction.editReply({ 
            content: '❌ Failed to generate AI response.' 
        });
    }
}

// Start the bot
client.login(process.env.DISCORD_TOKEN);

// Export for Render
module.exports = { createTicketButton };
