import WebSocket from "ws"
import { chat_with_content, gen_img, get_discrption_from_img } from "./get_img.js"
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
                const result = await gen_img(task.data, task.resolution)
                send_group_img(ws, task.group_id, task.user_id, result, task.data)
                logInfo('image task finished', { output: result })
            } catch (err) {
                 logError('image task failed', err)
            } 
        }
    } catch(err) {
        logError('queue processing failed', err)
    } finally {
        generation = false
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
                const help_msg = 'bot使用方法\r\n1.@bot生图 开始生成图片\r\n2.引用图片 然后输入`反推` 进行图片提示词反推\r\n3.生成 3k 图片需要加上 3K_H生成横向或者 3K_V竖向'
                sendGroupMsg(ws, data.group_id, help_msg, data.user_id)
                return
            }



            else if (msg_data.data.text.trim().startsWith('生图') && reply_msg) {
                    const trimed_msg_data = msg_data.data.text.trim()
                    const lower_msg_data = trimed_msg_data.toLowerCase()
                    if (lower_msg_data.includes('3k_v')) resolution = '1728x3072'
                    else if (lower_msg_data.includes('3k_h')) resolution = '3072x1728'
                    else  resolution = 'auto'
                    const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
                    logDebug('reply target fetched', promise_data)
                    if (promise_data.data?.message) {
                        for (const msg of promise_data.data.message) {
                            if (msg.type === 'text') {
                                // console.log(JSON.stringify(msg))
                                const forward_msg_data = msg.data?.text
                                if (forward_msg_data) {
                                    logInfo('enqueue image task', { groupId: data.group_id, userId: data.user_id, prompt: forward_msg_data, resolution: resolution })
                                    process_queue(ws, {
                                    'group_id': data.group_id,
                                    'data': `${forward_msg_data}\r\n${msg_data.data.text}`,
                                    'user_id': data.user_id,
                                    'resolution': resolution
                                    })
                                    return
                                }
                            }
                        }
                    }
                }


            if (msg_data.data.text.trim() != ''){
                if(msg_data.data.text.trim().startsWith('生图') && at_me)
                {
                // const chunked_data = msg_data.data.text.slice(5)
                const trimed_msg_data = msg_data.data.text.trim()
                const lower_msg_data = trimed_msg_data.toLowerCase()
                if (lower_msg_data.includes('3k_v'))  resolution = '1728x3072'
                else if (lower_msg_data.includes('3k_h'))  resolution = '3072x1728'
                else  resolution = 'auto'
                const chunked_data = msg_data.data.text
                logInfo('enqueue image task', { groupId: data.group_id, userId: data.user_id, prompt: chunked_data, resolution: resolution })
                process_queue(ws, {
                        'group_id': data.group_id,
                        'data': chunked_data,
                        'user_id': data.user_id,
                        'resolution': resolution

                })
                }

            else if (msg_data.data.text.trim().startsWith('Chat')&& reply_msg) {
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
                }
            }

        }
    }
        
    }
    } catch (err) {logError(err)}
    }
})
