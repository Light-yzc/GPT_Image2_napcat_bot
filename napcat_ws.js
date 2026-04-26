import WebSocket from "ws"
import { chat_with_content, gen_img, get_discrption_from_img } from "./get_img.js"
import { log } from "node:console"
const token = 'yzcqwer'
const WHITELIST = JSON.parse(process.env.WHITELIST || '[]')
let self_qq_id = -999
const DEBUG = process.env.DEBUG === '1'
const ws = new WebSocket('ws://127.0.0.1:3001',{
    headers:{
        Authorization: `Bearer ${token}`
    },
})
const pendingMap = new Map()

function logInfo(...args) {
    console.log('[napcat]', ...args)
}

function logWarn(...args) {
    console.warn('[napcat]', ...args)
}

function logError(...args) {
    console.error('[napcat]', ...args)
}

function logDebug(...args) {
    if (DEBUG) {
        console.log('[napcat:debug]', ...args)
    }
}

function formatTaskError(err, maxLength = 220) {
    const rawMessage = err?.message || String(err || '未知错误')
    const compactMessage = rawMessage.replace(/\s+/g, ' ').trim()

    if (compactMessage.length <= maxLength) {
        return compactMessage
    }

    return `${compactMessage.slice(0, maxLength)}...`
}

class user_queue{
    constructor(maxsize=5){
        this.queue = []
        this.maxsize = maxsize
    }
    mypush(task){
        logDebug('queue before push', this.queue)
        if (this.queue.length >= this.maxsize) return 'FAIL! queue is full!'
        else {
            this.queue.push(task)
            return `排队中。当前在第${this.queue.length}位。生图时间较长，耐心等待喵～`
        }
    }
    mypop(){
        if (this.queue.length === 0) return
        else {
            return this.queue.shift()
        }
        
    }
}

function sendGroupMsg(ws, groupId, message, user_id = 'none', echo = 'send_group_msg', use_forward=false) {
    logDebug('send group message', { groupId, user_id, echo, use_forward })
    if (!use_forward){
        const content = []

        ws.send(JSON.stringify({
            action: 'send_group_msg',
            params: {
            group_id: groupId,
            message: [
                user_id?{
                    type: 'at',
                    data: {
                        qq: String(user_id)
                    }
                }:[],
                {
                    type: 'text',
                    data: {
                        'text': `\r\n${message}`
                    }
                }
            ]
            },
            echo
    }))
    }
    else {
        ws.send(JSON.stringify({
            action: 'send_group_forward_msg',
            params: {
            group_id: groupId,
            message: {
                type: 'node',
                data: {
                    user_id: String(self_qq_id),
	                nickname: 'AI Bot',
                    content: [
                        {
                            type: 'at',
                            data: {
                                qq: String(user_id)
                            }
                        },
                        {
                            type: 'text',
                            data: {
                            text:  message
                            }
                         }
                    ] 
                }
            }
            },
            echo
        }))
    }

}

function get_msg_byID(ws, id) {
    return new Promise((resolve, reject) => {
        const echo = `get_msg_${id}_${Date.now()}`
        pendingMap.set(echo, {resolve, reject})
        ws.send(JSON.stringify({
        action: 'get_msg',
        params: {
            message_id: String(id)
        },
        echo
    }))
    })

}
function send_group_img(ws, groupId, user_id, img_path, user_text) {
	    ws.send(JSON.stringify({
	    action: 'send_group_forward_msg',
	    params: {
	      group_id: groupId,
	      messages: [
	        {
	          type: 'node',
	          data: {
	            user_id: String(self_qq_id),
	            nickname: 'AI Bot',
	            content: [
	              {
	                type: 'at',
	                data: {
	                  qq: String(user_id)
	                }
	              },
	              {
	                type: 'text',
	                data: {
	                  text:  `你请求的 **${user_text}** 生成好了喵！`
	                }
	              }
	            ]
	          }
	        },
	        {
	          type: 'node',
	          data: {
	            user_id: String(self_qq_id),
	            nickname: 'AI Bot',
	            content: [
	              {
	                type: 'image',
	                data: {
	                  file: `file:///${img_path}` // TODO: docker 内仍需可访问这个路径
	                }
	              }
	            ]
	          }
	        }
	      ],
	      summary: 'AI 图片生成结果',
	      prompt: '[合并转发]',
	      source: 'AI Bot'
	    },
	    echo: `send_group_forward_${Date.now()}`
	  }))
}

const userQueue = new user_queue()
ws.on('open', () => {
    logInfo('websocket connected')
    ws.send(JSON.stringify(
        {
        action: 'get_login_info'
        }
    ))
})
let generation = false
function process_queue(ws, task) {
    const queue_res = userQueue.mypush(task)
    sendGroupMsg(ws, task.group_id, queue_res, task.user_id)
    if (!generation){
        processQueue(ws)
    }
}

async function processQueue(ws) {
    if (generation) return
    generation = true

    try{
        while (userQueue.queue.length > 0) {
            const task = userQueue.mypop()
            try{
                logInfo('start image task', { groupId: task.group_id, userId: task.user_id, prompt: task.data,resolution: task.resolution })
                const result = await gen_img(task.data, task.resolution, task.edit, task.img_url)
                if (result.startsWith('[ERROR]')) {
                    sendGroupMsg(ws, task.group_id, result, task.user_id)
                }
                else {
                    send_group_img(ws, task.group_id, task.user_id, result, task.data)
                }
                logInfo('image task finished', { output: result })
            } catch (err) {
                 logError('image task failed', err)
                 sendGroupMsg(
                    ws,
                    task.group_id,
                    `生图失败了喵：${formatTaskError(err)}`,
                    task.user_id,
                 )
            } 
        }
    } catch(err) {
        logError('queue processing failed', err)
    } finally {
        generation = false
    }
}


async function put_img_in_queue(ws, msg_data, cur_reply_msg_id, data, reply_msg = false, edit_msg = false) {
    const trimed_msg_data = msg_data.data.text.trim()
    const lower_msg_data = trimed_msg_data.toLowerCase()
    let resolution = ''
    if (lower_msg_data.includes('3k_v')) resolution = '1728x3072'
    else if (lower_msg_data.includes('3k_h')) resolution = '3072x1728'
    else  resolution = 'auto'
    
    if (reply_msg) {
        const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
        logDebug('reply target fetched', promise_data)
        if (promise_data.data?.message) {
            for (const msg of promise_data.data.message) {
                if (msg.type === 'text' && edit_msg === false) {
                    // console.log(JSON.stringify(msg))
                    const forward_msg_data = msg.data?.text
                    if (forward_msg_data) {
                        logInfo('enqueue image task', { groupId: data.group_id, userId: data.user_id, prompt: forward_msg_data, resolution: resolution })
                        process_queue(ws, {
                        'group_id': data.group_id,
                        'data': `${forward_msg_data}\r\n${msg_data.data.text}`,
                        'user_id': data.user_id,
                        'resolution': resolution,
                        'edit': false
                        })
                        return
                    }
                }
                else if (msg.type === 'image' && edit_msg === true) {
                    const img_url = msg.data.url
                    logInfo('edit image', { groupId: data.group_id, userId: data.user_id, resolution: resolution })
                    process_queue(ws, {
                    'group_id': data.group_id,
                    'data': `${msg_data.data.text}`,
                    'user_id': data.user_id,
                    'resolution': resolution,
                    'edit': true,
                    'img_url': img_url
                    })
                }
            }
        }
    }
    else {
        const chunked_data = msg_data.data.text
        logInfo('enqueue image task', { groupId: data.group_id, userId: data.user_id, prompt: chunked_data, resolution: resolution })
        process_queue(ws, {
                'group_id': data.group_id,
                'data': chunked_data,
                'user_id': data.user_id,
                'resolution': resolution,
                'edit': false

        })
    }

}

ws.on("message", async (raw_data)=>{
    logDebug('message received')
    let at_me = false
    let reply_msg = false
    let cur_reply_msg_id = null
    let prev_text = ''
    let resolution = ''
    const data = JSON.parse(raw_data)
    if (data?.status && data?.echo) {
        const pending = pendingMap.get(data.echo)
        if (pending) {
            pending.resolve(data)
            pendingMap.delete(data.echo)
            return
        }
    }
    const acc_info = data?.self_id
    if (acc_info) {
        self_qq_id = data.self_id
        logInfo('login info loaded', { self_qq_id })
    }
    logDebug('incoming payload', data)
    if (WHITELIST.includes(String(data.group_id))) {
    logDebug('message in whitelist group', { groupId: data.group_id })

    try {
        for (const msg_data of data.message) {
        //handle img gen
        if (msg_data.type === 'at') {
            if (String(msg_data.data.qq) === String(self_qq_id)) at_me = true
        }
        if (msg_data.type === 'reply') {
            reply_msg = true
            cur_reply_msg_id = msg_data.data.id
            logDebug('reply message detected', { replyId: cur_reply_msg_id })
        }
        if (msg_data.type === 'text' && msg_data?.data?.text) {
            if (msg_data.data.text.includes('/help')){
                const help_msg = [
                    'bot 使用方法',
                    '1. @bot 生图 + 提示词：直接生成图片',
                    '2. 回复一条文本再发 生图：基于被回复内容继续补充提示词生图',
                    '3. 回复一张图片再发 改图 + 要求：按你的要求做图生图',
                    '4. 回复一张图片再发 反推：反推这张图的提示词',
                    '5. 回复文本或图片再发 Chat + 问题：结合被回复内容继续对话',
                    '6. 需要 3K 图时，在命令里加 3K_H 或 3K_V',
                    '7. 发送 /help 可再次查看本帮助',
                    '',
                    '示例：',
                    '@bot 生图 赛博朋克猫娘 3K_V',
                    '回复一段提示词后发送：生图 加一点雨夜霓虹感',
                    '回复一张图后发送：改图 改成吉卜力风格',
                    '回复一张图后发送：反推',
                    '回复一张图后发送：Chat 这张图哪里还能优化？',
                ].join('\r\n')
                sendGroupMsg(ws, data.group_id, help_msg, data.user_id)
                return
            }



            else if (msg_data.data.text.trim().startsWith('生图') && reply_msg) {
                    put_img_in_queue(ws, msg_data, cur_reply_msg_id, data, true, false)
                    return
                }



            else if (msg_data.data.text.trim().startsWith('改图') && reply_msg) {
                put_img_in_queue(ws, msg_data, cur_reply_msg_id, data, true, true)
                return
            } 



            else if (msg_data.data.text.trim() != ''){
                if(msg_data.data.text.trim().startsWith('生图') && at_me)
                {
                    put_img_in_queue(ws, msg_data, cur_reply_msg_id, data, false, false)
                    return
                }



            else if (msg_data.data.text.trim().toLowerCase().startsWith('chat')&& reply_msg) {
                const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
                logDebug('gen chat msg', promise_data)
                if (promise_data.data?.message) {
                    for (const msg of promise_data.data.message) {
                        if (msg.type === 'image') {
                            if (msg.data?.url) {
                                const chat_return = await chat_with_content(msg.data.url, null, msg_data.data.text)
                                sendGroupMsg(ws, data.group_id, chat_return, data.user_id)

                            }
                        }
                        if (msg.type === 'text') {
                            if (msg.data?.text) {
                                const chat_return = await chat_with_content(null, msg.data.text, msg_data.data.text)
                                sendGroupMsg(ws, data.group_id, chat_return, data.user_id)

                            }
                        }
                    }
                    return
                }

            }


            else if (msg_data.data.text.trim().startsWith('反推') && reply_msg) {
                const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
                logDebug('reply target fetched', promise_data)
                if (promise_data.data?.message) {
                    for (const msg of promise_data.data.message) {
                        if (msg.type === 'image') {
                            if (msg.data?.url) {
                                logInfo('start image description', { url: msg.data.url })
                                const img_info = await get_discrption_from_img(msg.data.url, msg_data.data.text)
                                sendGroupMsg(ws, data.group_id,img_info,data.user_id)
                            }
                        }
                    }
                    return
                }
            }

        }
    }
        
    }
    } catch (err) {logError(err)}
    }
})
