const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, SlashCommandBuilder, Routes, REST, ApplicationCommandType, ContextMenuCommandBuilder } = require('discord.js');
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
const SUPPORT_ROLE_IDS = process.env.SUPPORT_ROLE_IDS ? process.env.SUPPORT_ROLE_IDS.split(',').filter(id => id.trim()) : [];
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID; // Channel where ticket button appears

// OpenRouter configuration
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'mistralai/mistral-7b-instruct:free';

// Store active tickets
const activeTickets = new Map();

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
                .toJSON(),
            new SlashCommandBuilder()
                .setName('close')
                .setDescription('Close this ticket (Staff only)')
                .toJSON(),
            new SlashCommandBuilder()
                .setName('setup-tickets')
                .setDescription('Setup the ticket system in this channel (Admin only)')
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

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'setup-tickets') {
        await setupTicketSystem(interaction);
    } else if (interaction.commandName === 'chat') {
        await handleChatCommand(interaction);
    } else if (interaction.commandName === 'close') {
        await handleCloseCommand(interaction);
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
    }
});

// Setup ticket system command
async function setupTicketSystem(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return await interaction.reply({ 
            content: '❌ You need administrator permissions to setup tickets.', 
            ephemeral: true 
        });
    }

    const embed = new EmbedBuilder()
        .setTitle('🌱 Garden Marketplace Support')
        .setDescription('Need help with your garden marketplace experience? Click the button below to create a support ticket!')
        .setColor(0x2ecc71)
        .addFields(
            { name: 'What we can help with:', value: '• Buying/Selling issues\n• Subscription questions\n• Payment problems\n• General support' },
            { name: 'Premium Benefits (£1/month):', value: '• 🐉 Dragon Fly each month\n• 💰 10 Shekels monthly\n• 💬 Priority chat access\n• 🎨 Priority chat color\n• 🎁 Prismatic pet giveaways' }
        );

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('Create Support Ticket')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎫')
        );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: '✅ Ticket system setup complete!', ephemeral: true });
}

// Create ticket
async function createTicket(interaction) {
    const channelName = `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;
    
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
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages]
                }))
            ]
        });

        // Store ticket data
        activeTickets.set(channel.id, {
            userId: interaction.user.id,
            userName: interaction.user.username,
            problem: null,
            messages: [],
            awaitingResponse: true
        });

        // Send greeting message (NOT marked as AI)
        const greetingEmbed = new EmbedBuilder()
            .setTitle('🌱 Welcome to Garden Marketplace Support!')
            .setDescription(`Hello ${interaction.user}! Thank you for contacting support. Please describe your issue or question in detail below, and our AI assistant will help you.`)
            .setColor(0x2ecc71)
            .addFields(
                { name: 'Please include:', value: '• What you need help with\n• Any error messages\n• Steps to reproduce the issue\n• Relevant order/details' }
            );

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

// Handle messages in ticket channels
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    // Check if message is in a ticket channel
    if (message.channel.parentId === TICKET_CATEGORY_ID && message.channel.name.startsWith('ticket-')) {
        const ticketData = activeTickets.get(message.channel.id);
        
        if (ticketData && ticketData.awaitingResponse && message.author.id === ticketData.userId) {
            // User is responding with their problem
            await handleUserProblem(message, ticketData);
        } else if (ticketData && !ticketData.awaitingResponse && message.author.id === ticketData.userId) {
            // User is responding to AI for more support
            await handleUserFollowup(message, ticketData);
        }
    }
});

// Handle user's initial problem description
async function handleUserProblem(message, ticketData) {
    ticketData.problem = message.content;
    ticketData.messages.push({ role: 'user', content: message.content });
    ticketData.awaitingResponse = false;
    
    // Send typing indicator
    await message.channel.sendTyping();
    
    try {
        // Generate AI response
        const aiResponse = await generateAIResponse(ticketData.messages);
        
        // Add AI response to messages
        ticketData.messages.push({ role: 'assistant', content: aiResponse });
        
        // Create response embed WITH AI disclosure
        const responseEmbed = new EmbedBuilder()
            .setDescription(aiResponse)
            .setColor(0x3498db)
            .setFooter({ 
                text: '🔮 This message was AI-generated by Ordinary AI | Provider: Ordinary AI' 
            });
        
        // Create support buttons
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

// Handle user follow-up messages
async function handleUserFollowup(message, ticketData) {
    ticketData.messages.push({ role: 'user', content: message.content });
    
    // Send typing indicator
    await message.channel.sendTyping();
    
    try {
        // Generate AI response
        const aiResponse = await generateAIResponse(ticketData.messages);
        
        // Add AI response to messages
        ticketData.messages.push({ role: 'assistant', content: aiResponse });
        
        // Create response embed WITH AI disclosure
        const responseEmbed = new EmbedBuilder()
            .setDescription(aiResponse)
            .setColor(0x3498db)
            .setFooter({ 
                text: '🔮 This message was AI-generated by Ordinary AI | Provider: Ordinary AI' 
            });
        
        // Create support buttons again
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
    
    ticketData.awaitingResponse = true;
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
    
    const staffEmbed = new EmbedBuilder()
        .setDescription(message)
        .setColor(0x9b59b6)
        .setFooter({ 
            text: `💬 This message was written by staff member ${interaction.user.username}` 
        });
    
    await interaction.reply({ 
        embeds: [staffEmbed] 
    });
}

// Handle /close command for staff
async function handleCloseCommand(interaction) {
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
    
    // Check if in a ticket channel
    if (!interaction.channel.name.startsWith('ticket-')) {
        return await interaction.reply({ 
            content: '❌ This command can only be used in ticket channels.', 
            ephemeral: true 
        });
    }
    
    await interaction.reply('🔒 Closing this ticket in 5 seconds...');
    
    setTimeout(async () => {
        try {
            await interaction.channel.delete();
            activeTickets.delete(interaction.channel.id);
        } catch (error) {
            console.error('Error deleting channel:', error);
        }
    }, 5000);
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

// Start the bot
client.login(process.env.DISCORD_TOKEN);
