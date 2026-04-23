import WebSocket from "ws"
import { gen_img, get_discrption_from_img } from "./get_img.js"
const token = 'yzcqwer'
const WHITELIST = [861369046]
let self_qq_id = -999
const ws = new WebSocket('ws://127.0.0.1:3001',{
    headers:{
        Authorization: `Bearer ${token}`
    },
})
const pendingMap = new Map()
class user_queue{
    constructor(maxsize=5){
        this.queue = []
        this.maxsize = maxsize
    }
    mypush(task){
        console.log('[debug]', this.queue)
        if (this.queue.length >= this.maxsize) return 'FAIL! queue is full!'
        else {
            this.queue.push(task)
            return `成功，排队中。当前在第${this.queue.length}位。生图时间较长，耐心等待喵～`
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
    if (!use_forward){
        ws.send(JSON.stringify({
            action: 'send_group_msg',
            params: {
            group_id: groupId,
            message: message
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
	                  text:  `你请求的 **${user_text}** 生成好啦`
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
    console.log('connect ws sercer')
    ws.send(JSON.stringify(
        {
        action: 'get_login_info'
        }
    ))
})
let generation = false
function process_queue(ws, task) {
    const queue_res = userQueue.mypush(task)
    sendGroupMsg(ws, task.group_id, queue_res)
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
                const result = await gen_img(task.data)
                send_group_img(ws, task.group_id, task.user_id, result, task.data)
                console.log(result)
                console.log('生成完毕')
            } catch (err) {
                 console.log('生成失败', err)
            } 
        }
    } catch(err) {
        console.log('生成失败', err)
    } finally {
        generation = false
    }
}

ws.on("message", async (raw_data)=>{
    console.log('监听中')
    let at_me = false
    let reply_msg = false
    let cur_reply_msg_id = null
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
    }
    console.dir(data, { depth: null })
    if (WHITELIST.includes(data.group_id)) {
    // console.log(msg_data)
    for (const msg_data of data.message) {
        //handle img gen
        if (msg_data.type === 'at') {
            if (String(msg_data.data.qq) === String(self_qq_id)) at_me = true
        }
        if (msg_data.type === 'reply') {
            reply_msg = true
            cur_reply_msg_id = msg_data.data.id
            // console.log(cur_reply_msg_id)
            // console.log('/////////')
        }
        if (msg_data.type === 'text' && msg_data?.data?.text) {
            // console.log(msg_data.data)
            if (msg_data.data.text.includes('/help')){
                const help_msg = 'bot使用方法\r\n1.@bot生图 开始生成图片\r\n2.引用图片 然后输入`反推` 进行图片提示词反推'
                sendGroupMsg(ws, data.group_id, help_msg, data.user_id)
                return
            }
            if (msg_data.data.text.trim() != ''){
                if(msg_data.data.text.trim().startsWith('生图') && at_me)
                {
                const chunked_data = msg_data.data.text.slice(5)
                process_queue(ws, {
                        'group_id': data.group_id,
                        'data': chunked_data,
                        'user_id': data.user_id,
                })
                }
                else if (msg_data.data.text.trim().startsWith('反推') && reply_msg) {
                    const promise_data = await get_msg_byID(ws, cur_reply_msg_id)
                    console.log('获取到信息！！', promise_data)
                    if (promise_data.data?.message) {
                        for (const msg of promise_data.data.message) {
                            if (msg.type === 'image') {
                                if (msg.data?.url) {
                                    console.log('开始获取图像信息')
                                    const img_info = await get_discrption_from_img(msg.data.url)
                                    sendGroupMsg(ws, data.group_id,img_info,data.user_id)
                                }
                            }
                        }
                    }
                }

            }
        }
        
    }
    }
})
